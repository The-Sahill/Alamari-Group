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
أنت محرك فهم طلبات لنظام إدارة Alamari Group.

مهمتك تحليل الطلب القادم من AppSheet وتحويله إلى خطة منظمة فقط.

ممنوع عليك تنفيذ أي تعديل.
ممنوع افتراض بيانات غير موجودة في الطلب.
إذا كان الطلب غير واضح، استخدم operation = "unknown".

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
مستوى الخطورة القادم من AppSheet: ${action.Risk_Level || ''}
هل يحتاج تأكيد حسب AppSheet: ${action.Confirmation_Required || ''}
حالة التأكيد: ${action.Confirmation_Status || ''}

العمليات المسموح لك باقتراحها فقط:
- read
- create
- update
- delete
- unknown

إذا كان operation = "update":
ضع فقط الحقول التي طلب المستخدم تغييرها داخل changes.

إذا لم يطلب المستخدم تغيير أي حقل:
اجعل changes كائنًا فارغًا {}.

إذا كان الطلب يستهدف DEALS، استخدم أسماء الأعمدة الأصلية فقط مثل:
Person_ID
Requirement_ID
Transaction_Type
Property_ID
Unit_ID
Assigned_Employee_ID
Pipeline
Stage
Expected_Value
Currency
Expected_Commission
Final_Commission
Final_Value
Probability
Lead_Source
Last_Contact_At
Next_Action
Next_Action_Date
Lost_Reason
Closed_Date
Status

لا تستخدم الأعمدة الافتراضية أو Related.
لا تخترع Deal_ID أو أي معرف غير موجود في الطلب.

أرجع JSON فقط بهذا الشكل:

{
  "intent": "",
  "operation": "unknown",
  "requested_action": "",
  "target_table": "",
  "target_record_id": "",
  "changes": {},
  "risk_level": "low",
  "confirmation_required": false,
  "summary": ""
}
`;

    const response = await ai.models.generateContent({
        model: "gemini-3.8-flash",
        contents: prompt,
    });

    const rawText = response.text
        .replace(/```json/gi, '')
        .replace(/```/g, '')
        .trim();

    let parsedResult;

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

    // يجب أن تكون النتيجة Object
    if (
        !aiResult ||
        typeof aiResult !== 'object' ||
        Array.isArray(aiResult)
    ) {
        throw new Error('AI analysis is not a valid object');
    }

    // الحقول الإلزامية
    const requiredFields = [
        'intent',
        'operation',
        'requested_action',
        'target_table',
        'target_record_id',
        'changes',
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


    // ==================================================
    // التحقق من operation
    // ==================================================

    const allowedOperations = [
        'read',
        'create',
        'update',
        'delete',
        'unknown'
    ];

    if (!allowedOperations.includes(aiResult.operation)) {
        throw new Error(
            `Invalid AI operation: ${aiResult.operation}`
        );
    }


    // ==================================================
    // التحقق من changes
    // ==================================================

    if (
        !aiResult.changes ||
        typeof aiResult.changes !== 'object' ||
        Array.isArray(aiResult.changes)
    ) {
        throw new Error(
            'AI changes must be an object'
        );
    }


    // ==================================================
    // التحقق من risk_level
    // ==================================================

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


    // ==================================================
    // confirmation_required يجب أن تكون Boolean
    // ==================================================

    if (typeof aiResult.confirmation_required !== 'boolean') {
        throw new Error(
            'confirmation_required must be boolean'
        );
    }


    // ==================================================
    // التحقق من الحقول النصية
    // ==================================================

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


    // ==================================================
    // قواعد مرتبطة بنوع العملية
    // ==================================================

    // update يجب أن يحتوي على changes
    if (
        aiResult.operation === 'update' &&
        Object.keys(aiResult.changes).length === 0
    ) {
        throw new Error(
            'Update operation requires at least one change'
        );
    }


    // read لا يجب أن يطلب تعديلات
    if (
        aiResult.operation === 'read' &&
        Object.keys(aiResult.changes).length > 0
    ) {
        throw new Error(
            'Read operation cannot contain changes'
        );
    }


    // delete لا يجب أن يحتوي على changes
    if (
        aiResult.operation === 'delete' &&
        Object.keys(aiResult.changes).length > 0
    ) {
        throw new Error(
            'Delete operation cannot contain changes'
        );
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

        // الحقول التي يسمح لمحرك AI باقتراح تعديلها
allowedWritableFields: [
    'Person_ID',
    'Requirement_ID',
    'Transaction_Type',
    'Property_ID',
    'Unit_ID',
    'Assigned_Employee_ID',
    'Pipeline',
    'Stage',
    'Expected_Value',
    'Currency',
    'Expected_Commission',
    'Final_Commission',
    'Final_Value',
    'Probability',
    'Lead_Source',
    'Last_Contact_At',
    'Next_Action',
    'Next_Action_Date',
    'Lost_Reason',
    'Closed_Date',
    'Status'
],

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

    const operation = String(
        aiResult.operation || 'unknown'
    ).trim().toLowerCase();

    const changes = aiResult.changes || {};

    const securityResult = {
        allowed: false,
        target_table: targetTable,
        operation: operation,
        server_risk_level: 'high',
        confirmation_required: true,
        execution_allowed_now: false,
        validated_changes: {},
        rejected_fields: [],
        reason: ''
    };


    // ==================================================
    // 1. التأكد من وجود الجدول
    // ==================================================

    if (!targetTable) {
        securityResult.reason = 'Target table is missing';
        return securityResult;
    }


    // ==================================================
    // 2. التأكد أن الجدول مسموح
    // ==================================================

    const tablePolicy = AI_SECURITY_POLICY[targetTable];

    if (!tablePolicy) {
        securityResult.reason =
            `Target table is not allowed: ${targetTable}`;

        return securityResult;
    }


    // ==================================================
    // 3. منع الحذف بالكامل حاليًا
    // ==================================================

    if (operation === 'delete') {
        securityResult.allowed = false;
        securityResult.server_risk_level = 'high';
        securityResult.confirmation_required = true;
        securityResult.reason =
            'Delete operations are blocked by server policy';

        return securityResult;
    }


    // ==================================================
    // 4. الطلب غير الواضح
    // ==================================================

    if (operation === 'unknown') {
        securityResult.allowed = false;
        securityResult.server_risk_level = 'medium';
        securityResult.confirmation_required = true;
        securityResult.reason =
            'Operation is unknown or unclear';

        return securityResult;
    }


    // ==================================================
    // 5. القراءة
    // ==================================================

    if (operation === 'read') {
        securityResult.allowed = true;
        securityResult.server_risk_level = 'low';
        securityResult.confirmation_required = false;

        // التنفيذ ما زال مغلقًا في هذه المرحلة
        securityResult.execution_allowed_now = false;

        securityResult.reason =
            'Read operation passed server security policy';

        return securityResult;
    }


    // ==================================================
    // 6. CREATE
    // ==================================================

    if (operation === 'create') {

        securityResult.allowed = true;
        securityResult.server_risk_level = 'medium';
        securityResult.confirmation_required = true;
        securityResult.execution_allowed_now = false;
        securityResult.reason =
            'Create operation requires confirmation';

        return securityResult;
    }


    // ==================================================
    // 7. UPDATE
    // ==================================================

    if (operation === 'update') {

        const changeEntries = Object.entries(changes);

        if (changeEntries.length === 0) {
            securityResult.allowed = false;
            securityResult.reason =
                'Update operation contains no changes';

            return securityResult;
        }


        // ----------------------------------------------
        // فحص كل حقل يريد AI تعديله
        // ----------------------------------------------

      for (const [field, value] of changeEntries) {

    // أي حقل غير موجود في القائمة البيضاء مرفوض
    if (!tablePolicy.allowedWritableFields.includes(field)) {

        securityResult.rejected_fields.push({
            field: field,
            reason: 'Field is not in allowed writable fields'
        });

        continue;
    }

    // حماية إضافية للحقول المحمية
    if (tablePolicy.protectedFields.includes(field)) {

        securityResult.rejected_fields.push({
            field: field,
            reason: 'Protected field'
        });

        continue;
    }

    // بقية فحص Stage و Status يبقى كما هو


            // ------------------------------------------
            // التحقق من Stage
            // ------------------------------------------

            if (field === 'Stage') {

                if (!tablePolicy.allowedStages.includes(value)) {

                    securityResult.rejected_fields.push({
                        field: field,
                        value: value,
                        reason: 'Invalid Stage value'
                    });

                    continue;
                }
            }


            // ------------------------------------------
            // التحقق من Status
            // ------------------------------------------

            if (field === 'Status') {

                if (!tablePolicy.allowedStatuses.includes(value)) {

                    securityResult.rejected_fields.push({
                        field: field,
                        value: value,
                        reason: 'Invalid Status value'
                    });

                    continue;
                }
            }


            // إذا اجتاز الحقل الفحص
            securityResult.validated_changes[field] = value;
        }


        // ==================================================
        // 8. إذا وجد أي حقل مرفوض نرفض العملية كلها
        // ==================================================

        if (securityResult.rejected_fields.length > 0) {

            securityResult.allowed = false;
            securityResult.server_risk_level = 'high';
            securityResult.confirmation_required = true;
            securityResult.execution_allowed_now = false;
            securityResult.reason =
                'One or more requested fields were rejected by server policy';

            return securityResult;
        }


        // ==================================================
        // 9. فحص الحقول المالية
        // ==================================================

        const changedFields =
            Object.keys(securityResult.validated_changes);

        const containsFinancialField =
            changedFields.some(
                field =>
                    tablePolicy.financialFields.includes(field)
            );


        if (containsFinancialField) {

            securityResult.allowed = true;
            securityResult.server_risk_level = 'high';
            securityResult.confirmation_required = true;
            securityResult.execution_allowed_now = false;
            securityResult.reason =
                'Financial changes require explicit confirmation';

            return securityResult;
        }


        // ==================================================
        // 10. فحص الحالات النهائية
        // ==================================================

        const requestedStatus =
            securityResult.validated_changes.Status;

        const requestedStage =
            securityResult.validated_changes.Stage;


        if (
            requestedStatus &&
            tablePolicy.sensitiveStatuses.includes(requestedStatus)
        ) {

            securityResult.allowed = true;
            securityResult.server_risk_level = 'high';
            securityResult.confirmation_required = true;
            securityResult.execution_allowed_now = false;
            securityResult.reason =
                'Sensitive deal status requires explicit confirmation';

            return securityResult;
        }


        if (
            requestedStage === 'مغلقة - ناجحة' ||
            requestedStage === 'مغلقة - خاسرة'
        ) {

            securityResult.allowed = true;
            securityResult.server_risk_level = 'high';
            securityResult.confirmation_required = true;
            securityResult.execution_allowed_now = false;
            securityResult.reason =
                'Closing a deal requires explicit confirmation';

            return securityResult;
        }


        // ==================================================
        // 11. تعديل عادي
        // ==================================================

        securityResult.allowed = true;
        securityResult.server_risk_level = 'medium';
        securityResult.confirmation_required = true;
        securityResult.execution_allowed_now = false;
        securityResult.reason =
            'Update passed field validation but requires confirmation';

        return securityResult;
    }


    // ==================================================
    // أي عملية لم نتوقعها
    // ==================================================

    securityResult.allowed = false;
    securityResult.server_risk_level = 'high';
    securityResult.confirmation_required = true;
    securityResult.execution_allowed_now = false;
    securityResult.reason =
        'Operation is not supported by server policy';

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