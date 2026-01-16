require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const mysql = require('mysql2');
const bcrypt = require('bcryptjs');
const formidable = require('formidable');

// --- 1. Database Connection ---
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

// Ensure 'uploads' folder exists
const uploadDir = path.join(__dirname, '../public/uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// --- 2. HTTP Server ---
const server = http.createServer(async (req, res) => {
    // CORS & Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // --- API ROUTES ---

    // 1. SIGNUP
    if (req.url === '/api/signup' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { fullName, username, phone, email, dobAD, password } = JSON.parse(body);
                // (Validation logic omitted for brevity, assume valid input based on previous steps)
                const hash = await bcrypt.hash(password, 10);
                await db.execute(
                    'INSERT INTO users (fullname, username, phone, email, dob_ad, password_hash, role) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [fullName, username, phone, email || null, dobAD, hash, 'passenger']
                );
                res.writeHead(201, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: "Registered successfully" }));
            } catch (err) {
                sendError(res, 500, err.message);
            }
        });
    }

    // 2. LOGIN
    else if (req.url === '/api/login' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { username, password } = JSON.parse(body);
                const [rows] = await db.execute('SELECT * FROM users WHERE username = ?', [username]);
                if (rows.length === 0) return sendError(res, 401, "Invalid credentials");
                
                const user = rows[0];
                const match = await bcrypt.compare(password, user.password_hash);
                if (!match) return sendError(res, 401, "Invalid credentials");

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    message: "Login successful",
                    user: { id: user.id, name: user.fullname, role: user.role }
                }));
            } catch (err) {
                sendError(res, 500, err.message);
            }
        });
    }

    // 3. APPLY DRIVER (Multipart Form)
    else if (req.url === '/api/apply-driver' && req.method === 'POST') {
        const form = new formidable.IncomingForm();
        form.uploadDir = uploadDir;
        form.keepExtensions = true;
        form.multiples = true;

        form.parse(req, async (err, fields, files) => {
            if (err) return sendError(res, 500, "File upload failed");

            try {
                // Helpers for Formidable v3/v2 compatibility
                const getVal = (f) => Array.isArray(f) ? f[0] : f;
                const getFile = (f) => {
                    if (!f) return null;
                    if (Array.isArray(f)) return f.map(file => file.newFilename).join(',');
                    return f.newFilename;
                };

                const sql = `INSERT INTO driver_applications (
                    user_id, first_name, last_name, dob, photo_face,
                    citizenship_front, citizenship_back, citizenship_issue_date, citizenship_no, pan_no,
                    vehicle_type, vehicle_brand, vehicle_model, vehicle_color, vehicle_year, plate_no, vehicle_photo,
                    license_no, license_expiry, license_photo,
                    billbook_pages, billbook_reg_page, billbook_renew_date, billbook_renew_page
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

                const values = [
                    getVal(fields.user_id), getVal(fields.first_name), getVal(fields.last_name), getVal(fields.dob), getFile(files.photo_face),
                    getFile(files.citizenship_front), getFile(files.citizenship_back), getVal(fields.citizenship_issue_date), getVal(fields.citizenship_no), getVal(fields.pan_no),
                    getVal(fields.vehicle_type), getVal(fields.vehicle_brand), getVal(fields.vehicle_model), getVal(fields.vehicle_color), getVal(fields.vehicle_year), getVal(fields.plate_no), getFile(files.vehicle_photo),
                    getVal(fields.license_no), getVal(fields.license_expiry), getFile(files.license_photo),
                    getFile(files.billbook_pages), getFile(files.billbook_reg_page), getVal(fields.billbook_renew_date), getFile(files.billbook_renew_page)
                ];

                await db.execute(sql, values);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: "Application submitted for verification." }));
            } catch (dbErr) {
                console.error(dbErr);
                sendError(res, 500, dbErr.message);
            }
        });
    }

    // 4. REQUEST RIDE
    // API: REQUEST RIDE (With Destination & Fare)
    else if (req.url === '/api/request-ride' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { passengerId, pickupLat, pickupLng, dropLat, dropLng } = JSON.parse(body);

                // 1. Calculate Distance & Fare
                const straightDist = getDistanceFromLatLonInKm(pickupLat, pickupLng, dropLat, dropLng);
                const estRoadDist = straightDist * 1.5; // Estimate road distance
                
                // Pricing: 50 NPR base + 40 NPR per km
                let fare = Math.round(50 + (estRoadDist * 40));
                if (fare < 100) fare = 100; // Minimum fare logic

                // 2. Save to DB
                const [result] = await db.execute(
                    `INSERT INTO ride_requests 
                    (passenger_id, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, distance_km, fare) 
                    VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [passengerId, pickupLat, pickupLng, dropLat, dropLng, estRoadDist.toFixed(2), fare]
                );
                
                // 3. Broadcast to Drivers
                broadcast({ 
                    type: 'NEW_RIDE_REQUEST', 
                    rideId: result.insertId, 
                    passengerId, 
                    lat: pickupLat, 
                    lng: pickupLng,
                    dropLat, dropLng,
                    fare,
                    dist: estRoadDist.toFixed(1)
                });
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    rideId: result.insertId, 
                    fare: fare,
                    message: `Ride requested! Fare: NPR ${fare}`
                }));

            } catch (err) { sendError(res, 500, err.message); }
        });
    }

    // 5. ACCEPT RIDE
    else if (req.url === '/api/accept-ride' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { rideId, driverId, passengerId } = JSON.parse(body);
                await db.execute('UPDATE ride_requests SET status = ?, driver_id = ? WHERE id = ?', ['accepted', driverId, rideId]);
                
                broadcast({ type: 'RIDE_ACCEPTED', rideId, driverId, passengerId });
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: "Accepted" }));
            } catch (err) { sendError(res, 500, err.message); }
        });
    }

    // API: UPDATE RIDE STATUS (Cancel, Decline, Complete)
    else if (req.url === '/api/update-ride-status' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { rideId, status, userId } = JSON.parse(body);

                // Update the DB
                await db.execute('UPDATE ride_requests SET status = ? WHERE id = ?', [status, rideId]);

                // Notify the other party via WebSocket
                broadcast({ 
                    type: 'STATUS_UPDATE', 
                    rideId, 
                    status, 
                    updaterId: userId 
                });

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: `Ride ${status}` }));
            } catch (err) { sendError(res, 500, err.message); }
        });
    }

    // API: SEARCH ADDRESS (Nominatim Proxy)
    else if (req.url.startsWith('/api/search-address') && req.method === 'GET') {
        const urlParams = new URLSearchParams(req.url.split('?')[1]);
        const q = urlParams.get('q');
        
        // Fetch from OpenStreetMap Nominatim
        const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=5&accept-language=en`);
        const data = await response.json();
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
    }

    // API: ADMIN - GET APPLICATIONS
    else if (req.url === '/api/admin/applications' && req.method === 'GET') {
        try {
            // Fetch only pending applications
            const [rows] = await db.execute("SELECT * FROM driver_applications WHERE status = 'pending'");
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(rows));
        } catch (err) {
            sendError(res, 500, err.message);
        }
    }

    // API: ADMIN - VERIFY APPLICATION (Approve/Reject)
    else if (req.url === '/api/admin/verify' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { applicationId, userId, status } = JSON.parse(body);

                // 1. Update the application status
                await db.execute(
                    'UPDATE driver_applications SET status = ? WHERE application_id = ?',
                    [status, applicationId]
                );

                // 2. If APPROVED, upgrade the user's role to 'driver'
                if (status === 'approved') {
                    await db.execute(
                        'UPDATE users SET role = ?, is_verified = 1 WHERE id = ?',
                        ['driver', userId]
                    );
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: "Status updated" }));
            } catch (err) {
                sendError(res, 500, err.message);
            }
        });
    }

    // --- STATIC FILE SERVING ---
    else {
        let filePath = req.url === '/' ? 'signup.html' : req.url;
        if (filePath.startsWith('/')) filePath = filePath.slice(1);
        const safePath = path.join(__dirname, '../public', filePath);
        
        fs.readFile(safePath, (err, content) => {
            if (err) {
                res.writeHead(404);
                res.end("Page not found");
            } else {
                const ext = path.extname(safePath);
                const mimeTypes = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.png': 'image/png' };
                res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
                res.end(content);
            }
        });
    }
});

// --- 3. WebSocket Server ---
const wss = new WebSocket.Server({ server });

function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
    });
}

function sendError(res, status, message) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
}

// Helper: Calculate distance between two coordinates in km
function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
    const R = 6371; // Radius of the earth in km
    const dLat = deg2rad(lat2 - lat1);
    const dLon = deg2rad(lon2 - lon1);
    const a = 
        Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.sin(dLon/2) * Math.sin(dLon/2); 
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
    const d = R * c; // Distance in km
    return d;
}

function deg2rad(deg) {
    return deg * (Math.PI/180);
}

server.listen(3000, () => console.log('✅ Server running on http://localhost:3000'));