// server.js

// Import library yang diperlukan
const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const admin = require('firebase-admin');
require('dotenv').config(); // Untuk memuat variabel dari file .env

// --- Inisialisasi Aplikasi ---
const app = express();
app.use(express.json()); // Mengizinkan server menerima data JSON

// --- Inisialisasi Firebase Admin SDK ---
// Pastikan file service account sudah ada di folder yang sama
const serviceAccount = require(process.env.GOOGLE_APPLICATION_CREDENTIALS);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// --- Konfigurasi ---
const PORT = process.env.PORT || 3000;
// URL API Midtrans (Ganti ke URL produksi jika sudah live)
const MIDTRANS_API_URL = 'https://api.sandbox.midtrans.com/v2/charge'; 
// Kunci server Anda dari file .env
const MIDTRANS_SERVER_KEY = process.env.MIDTRANS_SERVER_KEY;


// --- Endpoint 1: Membuat Permintaan Pembayaran ---
// Aplikasi pengguna akan memanggil endpoint ini
app.post('/create-payment', async (req, res) => {
    try {
        const { amount, orderId, userName, paymentMethod } = req.body;

        if (!amount || !orderId || !userName || !paymentMethod) {
            return res.status(400).json({ error: 'Data tidak lengkap.' });
        }

        // Siapkan data untuk dikirim ke Midtrans
        const transactionData = {
            payment_type: paymentMethod, // 'gopay' atau 'qris'
            transaction_details: {
                order_id: orderId,
                gross_amount: amount
            },
            customer_details: {
                first_name: userName
            }
        };

        // Buat otorisasi dengan Server Key
        const authString = Buffer.from(`${MIDTRANS_SERVER_KEY}:`).toString('base64');

        // Kirim permintaan ke server Midtrans
        const response = await fetch(MIDTRANS_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': `Basic ${authString}`
            },
            body: JSON.stringify(transactionData)
        });

        const responseData = await response.json();

        if (!response.ok) {
            throw new Error(responseData.status_message || 'Gagal membuat permintaan pembayaran.');
        }
        
        // Ambil data yang relevan dari respons Midtrans
        const paymentInfo = {
            qrCodeUrl: responseData.actions?.find(action => action.name === 'generate-qr-code')?.url,
            deeplinkUrl: responseData.actions?.find(action => action.name === 'deeplink-redirect')?.url,
            expiryTime: responseData.expiry_time
        };

        res.status(200).json(paymentInfo);

    } catch (error) {
        console.error('Error membuat pembayaran:', error);
        res.status(500).json({ error: error.message });
    }
});


// --- Endpoint 2: Menerima Notifikasi dari Midtrans (Webhook) ---
// URL ini yang Anda daftarkan di dasbor Midtrans
app.post('/midtrans-webhook', async (req, res) => {
    try {
        const notification = req.body;
        console.log('Menerima notifikasi webhook:', JSON.stringify(notification, null, 2));

        // Validasi Signature Key (SANGAT PENTING di produksi)
        const signatureKey = crypto.createHash('sha512')
                                   .update(`${notification.order_id}${notification.status_code}${notification.gross_amount}${MIDTRANS_SERVER_KEY}`)
                                   .digest('hex');
        
        if (signatureKey !== notification.signature_key) {
            return res.status(403).send('Signature tidak valid.');
        }

        // Cek status transaksi
        const orderId = notification.order_id;
        const transactionStatus = notification.transaction_status;
        const fraudStatus = notification.fraud_status;

        // Cari pengguna berdasarkan orderId yang disimpan di data mereka
        const usersRef = collection(db, 'users');
        const q = query(usersRef, where("pendingPayment.orderId", "==", orderId));
        const querySnapshot = await getDocs(q);

        if (querySnapshot.empty) {
            console.warn(`Order ID ${orderId} tidak ditemukan di database.`);
            return res.status(404).send('Order ID tidak ditemukan.');
        }

        const userDoc = querySnapshot.docs[0];
        const userData = userDoc.data();
        const userRef = userDoc.ref;

        if (transactionStatus === 'settlement' && fraudStatus === 'accept') {
            console.log(`Pembayaran untuk order ${orderId} berhasil.`);
            
            const { amount, months, method } = userData.pendingPayment;
            
            const newPaymentRecord = { amount, method, months, paidAt: new Date() };
            const newArrears = userData.arrears.filter(month => !months.includes(month));

            await updateDoc(userRef, {
                arrears: newArrears,
                paymentHistory: arrayUnion(newPaymentRecord),
                pendingPayment: null // Hapus data pembayaran yang tertunda
            });
        }

        res.status(200).send('OK');

    } catch (error) {
        console.error('Error menangani webhook:', error);
        res.status(500).send('Internal Server Error');
    }
});


// --- Menjalankan Server ---
app.listen(PORT, () => {
    console.log(`Server berjalan di http://localhost:${PORT}`);
});
