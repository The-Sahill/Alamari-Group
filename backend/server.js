const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { GoogleGenAI } = require('@google/genai'); 
const { getPrompt } = require('./controllers/prompt'); 

const app = express();
app.use(bodyParser.json());


const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
});

// دالة لإرسال رسالة نصية عبر واتساب مباشرة
async function sendWhatsAppMessage(recipientID, text) {
    await axios({
        method: 'POST',
        url: `https://graph.facebook.com/v20.0/${process.env.PHONE_NUMBER_ID}/messages`,
        headers: {
            'Authorization': `Bearer ${process.env.ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
        },
        data: {
            messaging_product: 'whatsapp',
            to: recipientID,
            type: 'text',
            text: { body: text }
        }
    });
}

// دالة لتوليد محتوى الـ AI مع إعادة المحاولة 3 مرات
async function generateAIContentWithRetry(prompt, retries = 3, delay = 1000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const aiResponse = await ai.models.generateContent({
                model: "gemini-3.8-flash",
                contents: prompt,
            });
            return aiResponse.text; // إرجاع النص إذا نجح الطلب
        } catch (error) {
            console.warn(`المحاولة رقم ${attempt} فشلت:`, error.message);
            if (attempt === retries) {
                throw error; // رمي الخطأ إذا انتهت المحاولات الثلاث
            }
            // انتظار قصير بين المحاولات
            await new Promise(res => setTimeout(res, delay));
        }
    }
}

app.get('/webhook', (req, res) => {
    const VERIFY_TOKEN = "yhihkuhyga"; 
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('WEBHOOK_VERIFIED');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    } else {
        res.sendStatus(400);
    }
});




// =====================================================
// AppSheet AI Actions Endpoint
// =====================================================

async function analyzeAppSheetAction(action) {
    const prompt = `
أنت محرك ذكاء اصطناعي لنظام إدارة Alamari Group.

حلل الطلب القادم من AppSheet.

بيانات الطلب:
نوع المستخدم: ${action.User_Type || ''}
رقم الموظف: ${action.Employee_ID || ''}
رقم الشخص: ${action.Person_ID || ''}
رقم واتساب: ${action.WhatsApp_Number || ''}
القناة: ${action.Channel || ''}
نوع الإدخال: ${action.Input_Type || ''}
النص الأصلي: ${action.Original_Input || ''}
النص المحول: ${action.Transcription || ''}
الإجراء المطلوب: ${action.Requested_Action || ''}
الجدول المستهدف: ${action.Target_Table || ''}
السجل المستهدف: ${action.Target_Record_ID || ''}
مستوى الخطورة: ${action.Risk_Level || ''}
هل يحتاج تأكيد: ${action.Confirmation_Required || ''}
حالة التأكيد: ${action.Confirmation_Status || ''}

مهمتك الآن هي فهم الطلب وتحليله فقط.
لا تنفذ أي تعديل على البيانات.

أرجع النتيجة بصيغة JSON فقط بالشكل التالي:
{
  "intent": "",
  "requested_action": "",
  "target_table": "",
  "target_record_id": "",
  "risk_level": "low",
  "confirmation_required": false,
  "summary": ""
}
`;

    const response = await ai.models.generateContent({
        model: "gemini-3.8-flash",
        contents: prompt,
    });

    // تنظيف رد Gemini من علامات Markdown
    const rawText = response.text
        .replace(/```json/gi, '')
        .replace(/```/g, '')
        .trim();

    let parsedResult;

    // تحويل النص إلى JSON حقيقي
    try {
        parsedResult = JSON.parse(rawText);
    } catch (error) {
        console.error('Failed to parse AI JSON:', rawText);
        throw new Error('Invalid JSON returned from AI');
    }

    return parsedResult;
}


// ======================================================
// التحقق من بنية نتيجة الذكاء الاصطناعي
// ======================================================

function validateAIAnalysis(aiResult) {

    if (
        !aiResult ||
        typeof aiResult !== 'object' ||
        Array.isArray(aiResult)
    ) {
        throw new Error('AI analysis is not a valid object');
    }

    const requiredFields = [
        'intent',
        'requested_action',
        'target_table',
        'target_record_id',
        'risk_level',
        'confirmation_required',
        'summary'
    ];

    for (const field of requiredFields) {
        if (!(field in aiResult)) {
            throw new Error(
                `Missing AI analysis field: ${field}`
            );
        }
    }

    const allowedRiskLevels = [
        'low',
        'medium',
        'high'
    ];

    if (!allowedRiskLevels.includes(aiResult.risk_level)) {
        throw new Error(
            `Invalid AI risk level: ${aiResult.risk_level}`
        );
    }

    if (typeof aiResult.confirmation_required !== 'boolean') {
        throw new Error(
            'confirmation_required must be boolean'
        );
    }

    const stringFields = [
        'intent',
        'requested_action',
        'target_table',
        'target_record_id',
        'summary'
    ];

    for (const field of stringFields) {
        if (typeof aiResult[field] !== 'string') {
            throw new Error(
                `AI analysis field ${field} must be a string`
            );
        }
    }

    return true;
}


// ======================================================
// Security Policy
// القواعد هنا يفرضها السيرفر وليس Gemini
// ======================================================

const AI_SECURITY_POLICY = {

    DEALS: {

        // مفتاح الجدول
        keyField: 'Deal_ID',

        // حقول لا يسمح للذكاء الاصطناعي بتعديلها مباشرة
        protectedFields: [
            '_RowNumber',
            'Deal_ID',
            'Created_At',
            'Updated_At',

            'Related المعاينات',
            'Related المهام',
            'Related التواصل',
            'Related المستندات',

            'deal-display',
            'Stage_AR',
            'Status_AR'
        ],

        // الحقول المالية تعتبر حساسة
        financialFields: [
            'Expected_Value',
            'Expected_Commission',
            'Final_Commission',
            'Final_Value',
            'Currency'
        ],

        // الحالات النهائية والحساسة
        sensitiveStatuses: [
            'مغلقة - ناجحة',
            'مغلقة - خاسرة',
            'مؤرشفة'
        ],

        // مراحل الصفقة المسموح بها
        allowedStages: [
            'عميل جديد',
            'تم التواصل',
            'مؤهل',
            'تم اقتراح عقارات',
            'معاينة',
            'تفاوض',
            'عرض',
            'عقد',
            'مغلقة - ناجحة',
            'مغلقة - خاسرة'
        ],

        // حالات الصفقة المسموح بها
        allowedStatuses: [
            'نشطة',
            'معلقة',
            'مغلقة - ناجحة',
            'مغلقة - خاسرة',
            'مؤرشفة'
        ]
    }
};


// ======================================================
// تقييم أمان طلب الذكاء الاصطناعي
// هذه الدالة لا تنفذ أي تعديل
// ======================================================

function evaluateAISecurity(action, aiResult) {

    const targetTable = String(
        aiResult.target_table ||
        action.Target_Table ||
        ''
    ).trim().toUpperCase();

    const requestedAction = String(
        aiResult.requested_action ||
        action.Requested_Action ||
        ''
    ).trim().toLowerCase();

    const securityResult = {
        allowed: false,
        target_table: targetTable,
        server_risk_level: 'high',
        confirmation_required: true,
        execution_allowed_now: false,
        reason: ''
    };


    // ------------------------------------------
    // 1. يجب تحديد الجدول
    // ------------------------------------------

    if (!targetTable) {
        securityResult.reason = 'Target table is missing';
        return securityResult;
    }


    // ------------------------------------------
    // 2. رفض أي جدول غير موجود في Security Policy
    // ------------------------------------------

    const tablePolicy = AI_SECURITY_POLICY[targetTable];

    if (!tablePolicy) {
        securityResult.reason =
            `Target table is not allowed: ${targetTable}`;

        return securityResult;
    }


    // ------------------------------------------
    // 3. منع الحذف
    // ------------------------------------------

    const deleteKeywords = [
        'delete',
        'remove',
        'erase',
        'حذف',
        'احذف',
        'إزالة'
    ];

    const isDeleteRequest = deleteKeywords.some(
        keyword => requestedAction.includes(keyword)
    );

    if (isDeleteRequest) {
        securityResult.allowed = false;
        securityResult.server_risk_level = 'high';
        securityResult.confirmation_required = true;
        securityResult.execution_allowed_now = false;
        securityResult.reason =
            'AI deletion is blocked by server security policy';

        return securityResult;
    }


    // ------------------------------------------
    // 4. القراءة والبحث
    // ------------------------------------------

    const readKeywords = [
        'read',
        'get',
        'find',
        'search',
        'list',
        'view',
        'query',
        'lookup',
        'عرض',
        'بحث',
        'ابحث',
        'قراءة',
        'اقرأ',
        'استعلام'
    ];

    const isReadRequest = readKeywords.some(
        keyword => requestedAction.includes(keyword)
    );

    if (isReadRequest) {
        securityResult.allowed = true;
        securityResult.server_risk_level = 'low';
        securityResult.confirmation_required = false;

        // ما زلنا لا ننفذ في هذه المرحلة
        securityResult.execution_allowed_now = false;

        securityResult.reason =
            'Read-only request allowed by server policy';

        return securityResult;
    }


    // ------------------------------------------
    // 5. طلب غير واضح
    // ------------------------------------------

    if (
        !requestedAction ||
        requestedAction === 'none' ||
        requestedAction === 'unknown'
    ) {
        securityResult.allowed = false;
        securityResult.server_risk_level = 'medium';
        securityResult.confirmation_required = true;
        securityResult.execution_allowed_now = false;
        securityResult.reason =
            'Requested action is missing or unclear';

        return securityResult;
    }


    // ------------------------------------------
    // 6. أي تعديل حاليًا يحتاج تأكيد
    // ------------------------------------------

    securityResult.allowed = true;
    securityResult.server_risk_level = 'medium';
    securityResult.confirmation_required = true;
    securityResult.execution_allowed_now = false;
    securityResult.reason =
        'Write operation requires confirmation and further validation';

    return securityResult;
}



// ======================================================
// AppSheet AI Action Endpoint
// ======================================================

app.post('/api/appsheet/ai-action', async (req, res) => {

    try {

        // ------------------------------------------
        // التحقق من المفتاح السري
        // ------------------------------------------

        const webhookSecret =
            req.headers['x-appsheet-secret'];

        if (
            !process.env.APPSHEET_WEBHOOK_SECRET ||
            webhookSecret !== process.env.APPSHEET_WEBHOOK_SECRET
        ) {

            console.warn(
                'Unauthorized AppSheet request'
            );

            return res.status(401).json({
                success: false,
                error: 'Unauthorized'
            });
        }


        const action = req.body;


        // ------------------------------------------
        // تسجيل البيانات الأساسية فقط
        // ------------------------------------------

        console.log(
            'AppSheet AI Action received:',
            {
                AI_Action_ID:
                    action.AI_Action_ID,

                User_Type:
                    action.User_Type,

                Channel:
                    action.Channel,

                Requested_Action:
                    action.Requested_Action,

                Target_Table:
                    action.Target_Table,

                Target_Record_ID:
                    action.Target_Record_ID,

                Risk_Level:
                    action.Risk_Level,

                Execution_Status:
                    action.Execution_Status
            }
        );


        // ------------------------------------------
        // التأكد من وجود رقم العملية
        // ------------------------------------------

        if (!action.AI_Action_ID) {

            return res.status(400).json({
                success: false,
                error: 'AI_Action_ID is required'
            });
        }


        // ------------------------------------------
        // تحليل الطلب بواسطة Gemini
        // ------------------------------------------

        console.log(
            'بدء تحليل طلب AppSheet بواسطة AI...'
        );

        const aiResult =
            await analyzeAppSheetAction(action);


        // ------------------------------------------
        // التحقق من JSON القادم من Gemini
        // ------------------------------------------

        validateAIAnalysis(aiResult);

        console.log(
            'AI Analysis Result:',
            aiResult
        );

        console.log(
            'AI Analysis validation: PASSED'
        );


        // ------------------------------------------
        // تطبيق Security Policy الخاصة بالسيرفر
        // ------------------------------------------

        const securityResult =
            evaluateAISecurity(action, aiResult);

        console.log(
            'Server Security Decision:',
            securityResult
        );


        // ------------------------------------------
        // لا يوجد تنفيذ فعلي حتى الآن
        // ------------------------------------------

        console.log(
            'Execution blocked: analysis/security phase only'
        );


        // ------------------------------------------
        // إرجاع نتيجة التحليل + قرار السيرفر
        // ------------------------------------------

        return res.status(200).json({

            success: true,

            message:
                'AI action analyzed and checked by server security policy',

            AI_Action_ID:
                action.AI_Action_ID,

            status:
                'security_checked',

            analysis:
                aiResult,

            security:
                securityResult
        });


    } catch (error) {

        console.error(
            'AppSheet AI Action error:',
            error
        );

        return res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});





app.post('/webhook', async (req, res) => {
    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
        // إرسال 200 فوراً لفيسبوك حتى لا يعيد إرسال الـ Webhook (تجنب التكرار)
        res.status(200).send('EVENT_RECEIVED');

        try {
            for (const entry of body.entry) {
                for (const change of entry.changes) {
                    if (change.field === 'messages') {
                        const value = change.value;
                        
                        if (value.messages && value.messages.length > 0) {
                            const message = value.messages[0];
                            const senderID = message.from; 
                            const messageText = message.text ? message.text.body : ''; 

                            if (!messageText) continue;

                            console.log(`رسالة جديدة من: ${senderID} -> النص: ${messageText}`);

                            const prompt = getPrompt(messageText);
                            let replyText = "";

                            try {
                                // محاولة جلب الرد مع آلية إعادة المحاولة (3 مرات)
                                const aiText = await generateAIContentWithRetry(prompt, 3, 1000);
                                replyText = aiText || "أهلاً بك في  الامعري جروب كيف يمكنني مساعدتك اليوم؟";
                            } catch (aiError) {
                                // إذا فشلت الـ 3 محاولات، يتم اعتماد الرسالة الثابتة للطوارئ
                                console.error('فشلت جميع محاولات الاتصال بالذكاء الاصطناعي:', aiError.message);
                                replyText = "يوجد عطل فني في الرد التلقائي من الرد  الالي";
                            }

                            // إرسال الرد للعميل
                            await sendWhatsAppMessage(senderID, replyText);
                            console.log('تم إرسال الرد بنجاح إلى العميل');
                        }
                    }
                }
            }
        } catch (error) {
            console.error('خطأ عام أثناء معالجة الرسالة:', error.message);
        }
    } else {
        res.sendStatus(404);
    }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});