const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const FIREBASE_DB_URL = "https://snaxu-rsm-21cc9-default-rtdb.firebaseio.com";
const EMAILJS_PUBLIC_KEY = "aYayezWpufVsy9LWI";
// EmailJS Private Key: EmailJS dashboard -> Account -> API Keys se lo.
// Server-side (non-browser) email bhejne ke liye ye lazmi hai, warna "strict origin check" error aayega.
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY;

// Vercel ko bolna hai ke body ko auto-parse na kare,
// kyunki Stripe ko raw (unparsed) body chahiye signature verify karne ke liye
module.exports.config = {
    api: {
        bodyParser: false,
    },
};

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
    await fetch('https://api.emailjs.com/api/v1.0/email/send', {
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
}

module.exports = async (req, res) => {
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
            // Pending order ka data Firebase se wapas nikalo
            const pendingRes = await fetch(`${FIREBASE_DB_URL}/pending_orders/${orderId.replace('#', '')}.json`);
            const data = await pendingRes.json();

            if (!data) {
                console.error('Pending order not found for:', orderId);
                return res.status(200).json({ received: true });
            }

            // Duplicate check: agar ye order pehle se "orders" mein save ho chuka hai to dobara mat karo
            const existingCheck = await fetch(`${FIREBASE_DB_URL}/orders.json?orderBy="orderId"&equalTo="${data.uniqueOrderId}"`);
            const existing = await existingCheck.json();
            if (existing && Object.keys(existing).length > 0) {
                console.log('Order already saved, skipping duplicate:', orderId);
                return res.status(200).json({ received: true });
            }

            // Final order Firebase mein save karo
            await fetch(`${FIREBASE_DB_URL}/orders.json`, {
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

            // Email bhejo (agar emailStatus 'on' hai)
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

            // Pending order clean up
            await fetch(`${FIREBASE_DB_URL}/pending_orders/${orderId.replace('#', '')}.json`, { method: 'DELETE' });

        } catch (err) {
            console.error('Webhook processing error:', err);
        }
    }

    res.status(200).json({ received: true });
};
