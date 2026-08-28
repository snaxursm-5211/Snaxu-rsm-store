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
// NAYA: Payment confirm hone ke baad, is order mein
// jo bhi products the unke liye Firebase mein
// verified_purchases/{productId}/{userUUID} = true likh deta hai.
// product.html isi flag ko check karke "Write a Review" ka
// access deta hai — sirf usi device/user ko, sirf usi product
// ke liye jo actually khareeda gaya ho.
// ==========================================
async function markVerifiedPurchases(data) {
    try {
        const uUID = data.userUUID;
        const prodIds = Array.isArray(data.productIds) ? data.productIds : [];

        if (!uUID || prodIds.length === 0) {
            console.warn('No userUUID or productIds found on order data, skipping review-verification mark.');
            return;
        }

        const writes = prodIds
            .filter(pid => !!pid)
            .map(pid =>
                fetch(`${FIREBASE_DB_URL}/verified_purchases/${pid}/${uUID}.json`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(true)
                }).then(res => {
                    if (!res.ok) {
                        console.error(`Failed to mark verified purchase for product ${pid}`);
                    }
                })
            );

        await Promise.all(writes);
        console.log('Verified purchases marked for products:', prodIds);
    } catch (err) {
        console.error('Error marking verified purchases:', err);
    }
}

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
        const cleanOrderId = orderId.replace('#', '');

        try {
            const pendingRes = await fetch(`${FIREBASE_DB_URL}/pending_orders/${cleanOrderId}.json`);
            const data = await pendingRes.json();

            if (!data) {
                console.error('Pending order not found for:', orderId);
                return res.status(200).json({ received: true });
            }

            // ==========================================
            // FIX: uniqueOrderId mein "#" hota hai, jo URL mein
            // fragment (#) ki tarah break ho jata hai agar encode na kiya jaye.
            // Isliye encodeURIComponent() lagana zaroori hai.
            // ==========================================
            const existingCheck = await fetch(
                `${FIREBASE_DB_URL}/orders.json?orderBy="orderId"&equalTo=${encodeURIComponent(`"${data.uniqueOrderId}"`)}`
            );
            const existing = await existingCheck.json();

            // Agar Firebase ne koi error diya (jaise missing index), usko duplicate mat samjho
            if (existing && existing.error) {
                console.error('Firebase duplicate-check query error:', existing.error);
            } else if (existing && Object.keys(existing).length > 0) {
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

            // Order successfully paid & saved -> unlock "Write a Review" for the
            // products that were actually bought in this order.
            await markVerifiedPurchases(data);

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

            await fetch(`${FIREBASE_DB_URL}/pending_orders/${cleanOrderId}.json`, { method: 'DELETE' });

        } catch (err) {
            console.error('Webhook processing error:', err);
        }
    }

    res.status(200).json({ received: true });
}

handler.config = {
    api: {
        bodyParser: false,
    },
};

module.exports = handler;
