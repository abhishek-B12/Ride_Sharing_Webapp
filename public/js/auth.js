const BACKEND_URL = "https://your-render-backend-url.com"; // You will update this later

document.getElementById('signupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const fullname = document.getElementById('fullname').value;
    const phone = document.getElementById('phone').value;
    const password = document.getElementById('password').value;
    const role = document.getElementById('role').value;
    const errorMsg = document.getElementById('errorMsg');

    // 1. Validation Logic
    if (fullname.length < 3) {
        errorMsg.innerText = "Name must be at least 3 characters.";
        return;
    }
    if (!/^\d{10}$/.test(phone)) {
        errorMsg.innerText = "Phone must be exactly 10 digits.";
        return;
    }
    if (password.length < 6) {
        errorMsg.innerText = "Password must be at least 6 characters.";
        return;
    }

    // 2. Send to Backend
    try {
        const res = await fetch(`${BACKEND_URL}/api/signup`, {
            method: 'POST',
            body: JSON.stringify({ fullname, phone, password, role })
        });
        
        if (res.ok) {
            window.location.href = 'login.html';
        } else {
            const data = await res.json();
            errorMsg.innerText = data.error;
        }
    } catch (err) {
        errorMsg.innerText = "Server Error";
    }
});