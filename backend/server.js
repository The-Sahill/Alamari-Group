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
    const VERIFY_TOKEN = "hjfjggftyditdk"; 
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
                                replyText = aiText || "أهلاً بك في منصة سوقية، كيف يمكنني مساعدتك اليوم؟";
                            } catch (aiError) {
                                // إذا فشلت الـ 3 محاولات، يتم اعتماد الرسالة الثابتة للطوارئ
                                console.error('فشلت جميع محاولات الاتصال بالذكاء الاصطناعي:', aiError.message);
                                replyText = "يوجد عطل فني في الرد التلقائي من الرد الآلي للحجوزات و الاستفسار يرجى التواصل على الرقم 00962791772424";
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