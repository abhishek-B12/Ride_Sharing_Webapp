require('dotenv').config();
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');       // NEW: File System module
const path = require('path');   // NEW: Path module
const mysql = require('mysql2');
const bcrypt = require('bcryptjs');

// 1. Database Connection
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'Ride_Sharing_Live',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

const db = pool.promise();

async function initializeDatabase() {
    try {
        const connection = await pool.promise().getConnection();
        console.log('✅ MySQL Connection Pool initialized.');
        connection.release();
    } catch (err) {
        console.error('❌ Database connection failed:', err);
        process.exit(1);
    }
}

// 2. HTTP Server
const server = http.createServer(async (req, res) => {
    // CORS Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // --- API ROUTES ---

    // API: SIGNUP
    if (req.url === '/api/signup' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { fullName, username, phone, email, dobAD, password } = JSON.parse(body);

                // Validations
                if (!fullName || !username || !phone || !dobAD || !password) return sendError(res, 400, "All fields required.");
                if (!/^[a-zA-Z\s]+$/.test(fullName)) return sendError(res, 400, "Name must be letters only.");
                if (/[0-9]/.test(username)) return sendError(res, 400, "Username cannot contain numbers.");
                if (!/^\d{10}$/.test(phone)) return sendError(res, 400, "Phone must be 10 digits.");
                
                // Age Check
                const birthDate = new Date(dobAD);
                const today = new Date();
                let age = today.getFullYear() - birthDate.getFullYear();
                if (today.getMonth() < birthDate.getMonth() || (today.getMonth() === birthDate.getMonth() && today.getDate() < birthDate.getDate())) age--;
                if (age < 16) return sendError(res, 400, "Must be 16+ years old.");

                // Password Check
                if (!/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/.test(password)) {
                    return sendError(res, 400, "Password weak: 8+ chars, Upper, Lower, Number, Symbol.");
                }

                const hash = await bcrypt.hash(password, 10);
                
                try {
                    await db.execute(
                        'INSERT INTO users (fullname, username, phone, email, dob_ad, password_hash, role) VALUES (?, ?, ?, ?, ?, ?, ?)',
                        [fullName, username, phone, email || null, dobAD, hash, 'passenger']
                    );
                    res.writeHead(201, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ message: "Registration Successful!" }));
                } catch (sqlErr) {
                    if (sqlErr.code === 'ER_DUP_ENTRY') return sendError(res, 400, "Username or Phone already exists.");
                    throw sqlErr;
                }
            } catch (err) {
                sendError(res, 500, err.message);
            }
        });
    }

    // API: LOGIN
    else if (req.url === '/api/login' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { username, password } = JSON.parse(body);
                const [rows] = await db.execute('SELECT * FROM users WHERE username = ?', [username]);
                
                if (rows.length === 0) return sendError(res, 401, "Invalid username or password.");
                
                const user = rows[0];
                const match = await bcrypt.compare(password, user.password_hash);
                
                if (!match) return sendError(res, 401, "Invalid username or password.");

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    message: "Login Successful", 
                    user: { id: user.id, name: user.fullname, role: user.role }
                }));
            } catch (err) {
                sendError(res, 500, err.message);
            }
        });
    }

    // API: REQUEST RIDE
    else if (req.url === '/api/request-ride' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { passengerId, lat, lng } = JSON.parse(body);
                
                const [result] = await db.execute(
                    'INSERT INTO ride_requests (passenger_id, pickup_lat, pickup_lng) VALUES (?, ?, ?)',
                    [passengerId, lat, lng]
                );

                // Broadcast to all connected WebSockets that a new ride is requested
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'NEW_RIDE_REQUEST',
                            rideId: result.insertId,
                            passengerId,
                            lat, lng
                        }));
                    }
                });

                res.writeHead(201, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: "Ride requested! Waiting for driver...", rideId: result.insertId }));
            } catch (err) {
                sendError(res, 500, err.message);
            }
        });
    }

    // API: ACCEPT RIDE
    else if (req.url === '/api/accept-ride' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { rideId, driverId, passengerId } = JSON.parse(body);

                // 1. Update Database
                await db.execute(
                    'UPDATE ride_requests SET status = ?, driver_id = ? WHERE id = ?',
                    ['accepted', driverId, rideId]
                );

                // 2. Notify the Passenger via WebSocket
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'RIDE_ACCEPTED',
                            rideId,
                            driverId,
                            passengerId // Helper to let client filter messages
                        }));
                    }
                });

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: "Ride accepted" }));
            } catch (err) {
                sendError(res, 500, err.message);
            }
        });
    }

    // --- STATIC FILE SERVING (THE FIX) ---
    else {
        // If the URL is just "/", serve index.html (or signup.html for now)
        let filePath = req.url === '/' ? 'signup.html' : req.url;
        
        // Remove leading slash to make it a relative path
        if (filePath.startsWith('/')) filePath = filePath.slice(1);
        
        // Look inside the 'public' folder
        const safePath = path.join(__dirname, '../public', filePath);
        
        // Get the file extension
        const ext = path.extname(safePath);
        const mimeTypes = {
            '.html': 'text/html',
            '.css': 'text/css',
            '.js': 'text/javascript',
            '.png': 'image/png',
            '.jpg': 'image/jpeg'
        };

        const contentType = mimeTypes[ext] || 'application/octet-stream';

        // Read the file and serve it
        fs.readFile(safePath, (err, content) => {
            if (err) {
                if (err.code === 'ENOENT') {
                    // File not found
                    res.writeHead(404);
                    res.end("Page not found");
                } else {
                    // Server error
                    res.writeHead(500);
                    res.end(`Server Error: ${err.code}`);
                }
            } else {
                // Success
                res.writeHead(200, { 'Content-Type': contentType });
                res.end(content, 'utf-8');
            }
        });
    }
});

// 3. WebSocket Server
const wss = new WebSocket.Server({ server });

function sendError(res, status, message) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
}

const PORT = process.env.PORT || 3000;
initializeDatabase().then(() => {
    server.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
    });
});