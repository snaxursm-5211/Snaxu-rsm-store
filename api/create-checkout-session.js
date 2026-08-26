
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { items, orderData } = req.body;

        const lineItems = items.map(item => {
            const priceNum = parseFloat(item.price.toString().replace(/[^\d.]/g, '')) || 0;
            return {
                price_data: {
                    currency: 'gbp',
                    product_data: {
                        name: item.name + (item.variation ? ` (${item.variation})` : ''),
                    },
                    unit_amount: Math.round(priceNum * 100),
                },
                quantity: item.quantity || 1,
            };
        });

        const deliveryNum = parseFloat(orderData.del.replace(/[^\d.]/g, '')) || 0;
        if (deliveryNum > 0) {
            lineItems.push({
                price_data: {
                    currency: 'gbp',
                    product_data: {
                        name: 'Delivery Charges',
                    },
                    unit_amount: Math.round(deliveryNum * 100),
                },
                quantity: 1,
            });
        }

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: lineItems,
            mode: 'payment',
            customer_email: orderData.cEmail,
            success_url: `${req.headers.origin}/checkout.html?payment=success`,
            cancel_url: `${req.headers.origin}/checkout.html?payment=cancel`,
            metadata: {
                orderId: orderData.uniqueOrderId,
            }
        });

        res.status(200).json({ id: session.id, url: session.url });
    } catch (error) {
        console.error('Stripe Error:', error);
        res.status(500).json({ error: error.message });
    }
};
