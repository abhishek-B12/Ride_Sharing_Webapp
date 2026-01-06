require('dotenv').config();
const http = require('http');
const WebSocket = require('ws');
const { Client } = require('pg');
const bcrypt = require('bcryptjs');

// 1. Database Connection
const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Required for Render/Cloud DBs
});
client.connect();

// 2. HTTP Server (The "API")
const server = http.createServer(async (req, res) => {
    // CORS Headers (Allow Vercel frontend to talk to Render backend)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // API Routes
    if (req.url === '/api/signup' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            const { fullname, phone, password, role } = JSON.parse(body);
            // (Server-side validation would go here)
            const hash = await bcrypt.hash(password, 10);
            try {
                await client.query(
                    'INSERT INTO users (fullname, phone, password_hash, role) VALUES ($1, $2, $3, $4)', 
                    [fullname, phone, hash, role]
                );
                res.writeHead(201, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: "User Created" }));
            } catch (err) {
                res.writeHead(500);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } 
    else {
        res.writeHead(404);
        res.end("Not Found");
    }
});

// 3. WebSocket Server (The "Live" Part)
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log('New Client Connected');

    ws.on('message', (message) => {
        const data = JSON.parse(message);
        
        // If a driver sends their location, broadcast it to everyone (simplification)
        if (data.type === 'update_location') {
            wss.clients.forEach(client => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: 'driver_moved',
                        driverId: data.driverId,
                        lat: data.lat,
                        lng: data.lng
                    }));
                }
            });
        }
    });
});

// Start Server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));