require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Expo } = require('expo-server-sdk');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Initialize Expo for push notifications
const expo = new Expo();

// Middleware
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'BizConnect Pro API is running' });
});

// Create payment intent
app.post('/api/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency = 'usd', customerEmail, customerName } = req.body;

    console.log('Payment intent request:', { amount, currency, customerEmail, customerName });

    // Validate input
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // Note: Stripe minimum is typically $0.50 for card payments
    // For testing with $0.05, use Stripe test mode or contact Stripe support
    if (amount < 0.50 && process.env.NODE_ENV === 'production') {
      return res.status(400).json({
        error: 'Amount too low. Stripe minimum is $0.50 for card payments.'
      });
    }

    // Create or find customer
    let customer;
    if (customerEmail) {
      console.log('Looking for existing customer with email:', customerEmail);
      // Try to find existing customer
      const existingCustomers = await stripe.customers.list({
        email: customerEmail,
        limit: 1
      });

      if (existingCustomers.data.length > 0) {
        customer = existingCustomers.data[0];
        console.log('Found existing customer:', customer.id, customer.name, customer.email);
      } else {
        console.log('Creating new customer with:', { email: customerEmail, name: customerName });
        // Create new customer
        customer = await stripe.customers.create({
          email: customerEmail,
          name: customerName || undefined,
          metadata: {
            platform: 'BizConnect Pro iOS App',
            user_id: 'bizconnect_user'
          }
        });
        console.log('Created new customer:', customer.id, customer.name, customer.email);
      }
    } else {
      console.log('No customer email provided');
    }

    // Prepare payment intent data
    const paymentIntentData = {
      amount: Math.round(amount), // Amount is already in cents
      currency,
      automatic_payment_methods: {
        enabled: true,
      },
      // Business information for card statements
      statement_descriptor: 'BizConnect Pro',
      statement_descriptor_suffix: 'Service',
      description: 'BizConnect Pro Business Service',
      metadata: {
        business_name: 'BizConnect Pro',
        service_type: 'Business Networking Platform',
        platform: 'iOS App'
      }
    };

    // Associate customer with payment intent
    if (customer) {
      paymentIntentData.customer = customer.id;
      paymentIntentData.receipt_email = customerEmail;
    } else {
      // Fallback: just add to metadata
      if (customerEmail) {
        paymentIntentData.receipt_email = customerEmail;
        paymentIntentData.metadata.customer_email = customerEmail;
      }
      if (customerName) {
        paymentIntentData.metadata.customer_name = customerName;
      }
    }

    // Create payment intent
    const paymentIntent = await stripe.paymentIntents.create(paymentIntentData);

    res.status(200).json({
      clientSecret: paymentIntent.client_secret,
    });
  } catch (error) {
    console.error('Error creating payment intent:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Register push token for user
app.post('/api/register-push-token', async (req, res) => {
  try {
    const { userId, token, deviceInfo } = req.body;

    console.log('Registering push token:', { userId, token: token?.substring(0, 20) + '...' });

    if (!userId || !token) {
      return res.status(400).json({ error: 'userId and token are required' });
    }

    // Check if token is valid Expo push token
    if (!Expo.isExpoPushToken(token)) {
      return res.status(400).json({ error: 'Invalid Expo push token' });
    }

    // Upsert the push token
    const { data, error } = await supabase
      .from('push_tokens')
      .upsert({
        user_id: userId,
        token: token,
        device_info: deviceInfo || {},
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'token'
      })
      .select();

    if (error) {
      console.error('Error registering push token:', error);
      return res.status(500).json({ error: 'Failed to register push token' });
    }

    console.log('Push token registered successfully for user:', userId);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error in register-push-token:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Send push notification to user
app.post('/api/send-push-notification', async (req, res) => {
  try {
    const { userId, title, body, data } = req.body;

    console.log('Sending push notification:', { userId, title, body: body?.substring(0, 50) + '...' });

    if (!userId || !title || !body) {
      return res.status(400).json({ error: 'userId, title, and body are required' });
    }

    // Get user's push token
    const { data: tokenData, error: tokenError } = await supabase
      .from('push_tokens')
      .select('token')
      .eq('user_id', userId)
      .single();

    if (tokenError || !tokenData) {
      console.log('No push token found for user:', userId);
      return res.json({ success: true, message: 'No push token found - notification stored only' });
    }

    // Check if token is still valid
    if (!Expo.isExpoPushToken(tokenData.token)) {
      console.error('Invalid push token for user:', userId);
      return res.status(400).json({ error: 'Invalid push token' });
    }

    // Send push notification
    const message = {
      to: tokenData.token,
      title,
      body,
      data: data || {},
      sound: 'default',
      priority: 'default'
    };

    console.log('Sending push notification to Expo...');
    const ticket = await expo.sendPushNotificationsAsync([message]);

    console.log('Push notification sent successfully:', ticket);
    res.json({ success: true, ticket });
  } catch (error) {
    console.error('Error sending push notification:', error);
    res.status(500).json({ error: 'Failed to send push notification' });
  }
});

// Send push notification to multiple users
app.post('/api/send-bulk-push-notification', async (req, res) => {
  try {
    const { userIds, title, body, data } = req.body;

    console.log('Sending bulk push notification to users:', userIds?.length);

    if (!userIds || !Array.isArray(userIds) || !title || !body) {
      return res.status(400).json({ error: 'userIds (array), title, and body are required' });
    }

    // Get push tokens for all users
    const { data: tokensData, error: tokensError } = await supabase
      .from('push_tokens')
      .select('user_id, token')
      .in('user_id', userIds);

    if (tokensError) {
      console.error('Error fetching push tokens:', tokensError);
      return res.status(500).json({ error: 'Failed to fetch push tokens' });
    }

    if (!tokensData || tokensData.length === 0) {
      console.log('No push tokens found for users');
      return res.json({ success: true, message: 'No push tokens found' });
    }

    // Create messages for each valid token
    const messages = tokensData
      .filter(item => Expo.isExpoPushToken(item.token))
      .map(item => ({
        to: item.token,
        title,
        body,
        data: data || {},
        sound: 'default',
        priority: 'default'
      }));

    if (messages.length === 0) {
      return res.json({ success: true, message: 'No valid push tokens found' });
    }

    console.log(`Sending bulk push notifications to ${messages.length} devices...`);
    const tickets = await expo.sendPushNotificationsAsync(messages);

    console.log('Bulk push notifications sent successfully');
    res.json({ success: true, tickets, sent: messages.length });
  } catch (error) {
    console.error('Error sending bulk push notification:', error);
    res.status(500).json({ error: 'Failed to send bulk push notification' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;

// Push notification endpoints
app.post('/api/send-push-notification', async (req, res) => {
  // Push notification logic
});

app.post('/api/register-push-token', async (req, res) => {
  // Token registration logic
});

