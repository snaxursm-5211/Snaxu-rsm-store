const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const FIREBASE_DB_URL = "https://snaxu-rsm-21cc9-default-rtdb.firebaseio.com";
const EMAILJS_PUBLIC_KEY = "aYayezWpufVsy9LWI";
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY;

function getRawBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => { data += chunk; });
        req.on('end', () => resolve(data));
        req.on('error', reject);
    });
}

async function sendEmailViaAPI(templateId, params) {
    if (!EMAILJS_PRIVATE_KEY) {
        console.warn('EMAILJS_PRIVATE_KEY not set, skipping server-side email');
        return;
    }
    const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            service_id: 'service_uk3f5lm',
            template_id: templateId,
            user_id: EMAILJS_PUBLIC_KEY,
            accessToken: EMAILJS_PRIVATE_KEY,
            template_params: params
        })
    });
    if (!res.ok) {
        const errText = await res.text();
        console.error('EmailJS send failed:', res.status, errText);
    }
}

// ==========================================
// YAHAN FIX HAI: function pehle bana ke, phir
// USI function ke upar .config set kiya hai,
// taake baad mein overwrite na ho
// ==========================================
async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).send('Method not allowed');
    }

    const sig = req.headers['stripe-signature'];
    const rawBody = await getRawBody(req);

    let event;
    try {
        event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const orderId = session.metadata.orderId;

        try {
            const pendingRes = await fetch(`${FIREBASE_DB_URL}/pending_orders/${orderId.replace('#', '')}.json`);
            const data = await pendingRes.json();

            if (!data) {
                console.error('Pending order not found for:', orderId);
                return res.status(200).json({ received: true });
            }

            const existingCheck = await fetch(`${FIREBASE_DB_URL}/orders.json?orderBy="orderId"&equalTo="${data.uniqueOrderId}"`);
            const existing = await existingCheck.json();
            if (existing && Object.keys(existing).length > 0) {
                console.log('Order already saved, skipping duplicate:', orderId);
                return res.status(200).json({ received: true });
            }

            const orderSaveRes = await fetch(`${FIREBASE_DB_URL}/orders.json`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    orderId: data.uniqueOrderId,
                    customerName: `${data.fName} ${data.lName}`,
                    customerPhone: data.phone,
                    emailAddress: data.cEmail,
                    deliveryCharges: data.del,
                    customerCity: data.city,
                    customerAddress: data.fullAddress,
                    postcode: data.postcode,
                    itemsDetailed: data.itemsString,
                    productName: data.itemSummary,
                    subtotal: data.sub,
                    price: data.grand,
                    paymentMethod: "Card / Stripe",
                    status: 'paid',
                    timestamp: Date.now(),
                    date: new Date().toLocaleString()
                })
            });

            if (!orderSaveRes.ok) {
                console.error('Failed to save order to Firebase:', await orderSaveRes.text());
            } else {
                console.log('Order saved successfully:', data.uniqueOrderId);
            }

            const statusRes = await fetch(`${FIREBASE_DB_URL}/settings/emailStatus.json`);
            const emailStatus = await statusRes.json();

            if (emailStatus === 'on') {
                const emailParams = {
                    order_id: data.uniqueOrderId,
                    customer_email: data.cEmail,
                    first_name: data.fName,
                    last_name: data.lName,
                    email_address: data.cEmail,
                    phone_number: data.phone,
                    country: data.country,
                    address_1: data.addr1,
                    address_2: data.addr2 ? data.addr2 : "N/A",
                    city: data.city,
                    county: data.county ? data.county : "N/A",
                    postcode: data.postcode,
                    order_items: data.itemsString,
                    product_price: data.sub,
                    delivery_charges: data.del,
                    grand_total: data.grand,
                    payment_method: "Credit / Debit Card (Stripe)"
                };
                await sendEmailViaAPI('template_enb5mx8', emailParams);
                await sendEmailViaAPI('template_cc3xonz', emailParams);
            }

            await fetch(`${FIREBASE_DB_URL}/pending_orders/${orderId.replace('#', '')}.json`, { method: 'DELETE' });

        } catch (err) {
            console.error('Webhook processing error:', err);
        }
    }

    res.status(200).json({ received: true });
}

// Config ab function ke UPAR set ho raha hai, isliye overwrite nahi hoga
handler.config = {
    api: {
        bodyParser: false,
    },
};

module.exports = handler;
