# 👤 User Authentication & Accounts Guide

## 🎬 Quick Start - Create Your First Account

### Option 1: Create Your Own Account (Recommended)

**In the App**:
1. Click "Create Account" button (top right)
2. Enter any email: `yourname@example.com`
3. Enter password: minimum 6 characters
4. Click "Create Account"
5. You're now logged in!

**That's it!** Your account is instantly created and stored in the database.

### Option 2: Demo Accounts (For Testing)

**Demo Account 1**:
- Email: `demo@example.com`
- Password: `demo123456`

**Demo Account 2**:
- Email: `test@example.com`
- Password: `password123`

**How to use**:
1. Click "Sign In"
2. Enter email from above
3. Enter password
4. Click "Sign In"

> **Note**: These accounts are created when you first run the system (via demo-seeder service). If you delete them with `docker compose down -v`, you'll need to create new ones.

---

## 💾 Session Persistence - How It Works

### Local Storage (Browser)

When you login, the app automatically saves your session in the browser:

```javascript
// These are automatically stored in your browser:
scalastream_token      // Your authentication token (JWT)
scalastream_user       // Your email and user ID
scalastream_autoplay   // Your video autoplay preference
```

### What This Means

| Scenario | What Happens |
|----------|--------------|
| Close browser tab/window | ✅ Session saved - login persists |
| Close all browser windows | ✅ Session saved - login persists |
| Restart computer | ✅ Session saved - login persists |
| Clear browser cache (Ctrl+Shift+Del) | ✗ Session cleared - need to login again |
| Logout from app | ✗ Session cleared - need to login again |
| Browser forgets localStorage | ✗ Session lost - need to login again |

### Docker Restarts

| Docker Command | Database | Login Still Works? |
|---|---|---|
| `docker compose restart` | ✅ Kept | ✅ **YES** - if browser cache intact |
| `docker compose down` | ✅ Kept | ✅ **YES** - if browser cache intact |
| `docker compose down -v` | ✗ Deleted | ❌ **NO** - need to recreate account |

**Key Point**: Your browser localStorage is SEPARATE from Docker data. Restarting Docker doesn't affect it, but using `docker compose down -v` deletes your DATABASE, not your browser cache.

---

## 🔍 View Your Stored Login Info

### Check Stored Credentials

**Chrome, Edge, or Firefox**:
1. Open the app at `http://localhost:3000`
2. Press **F12** to open Developer Tools
3. Click **Application** tab
4. In left panel, select **Local Storage**
5. Click `http://localhost:3000`
6. You'll see your stored data:
   - `scalastream_token` - Your auth token
   - `scalastream_user` - Your account info
   - `scalastream_autoplay` - Autoplay setting

### Example Output
```
Key                              Value
scalastream_token                eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
scalastream_user                 {"id":"550e8400-e29b","email":"you@example.com"}
scalastream_autoplay             true
```

---

## 🔑 Password Security

### Best Practices

✅ **Good Passwords**:
- `MyStrongPassword123` (12+ characters)
- `Streaming@2024Blue` (mix of cases + numbers)
- `SecureVideoPass#42` (includes special chars)

❌ **Bad Passwords**:
- `123456` (too short)
- `password` (too simple)
- `abc` (way too short)

### Requirements
- Minimum 6 characters
- No other restrictions (for development)
- In production, should enforce: uppercase, lowercase, numbers, special chars

---

## 🔄 Forgot Your Password?

### Current System (Development)
**The app doesn't have password recovery yet.** Solutions:

**Option 1: Create a new account**
```
1. Click "Create Account"
2. Use a different email
3. Use a password you'll remember
```

**Option 2: Delete and recreate database** (if you're admin)
```bash
# Remove all accounts
docker compose down -v

# Recreate fresh
docker compose up -d --build

# Use demo accounts again
#   Email: demo@example.com
#   Password: demo123456
```

### Future: Better Password Management
- Email verification
- Password reset link
- 2FA (Two-Factor Authentication)
- OAuth (Google, GitHub login)

---

## 🚀 Multiple Accounts

### Create Different Accounts

Each email can only be registered ONCE. To test multiple users:

**Account 1 - Your Main Account**:
- Email: `you@example.com`
- Password: `yourPassword123`

**Account 2 - Test Creator**:
- Email: `creator@example.com`
- Password: `creatorPass123`

**Account 3 - Test Viewer**:
- Email: `viewer@example.com`
- Password: `viewerPass123`

### Switch Between Accounts

**Option 1: Different Browser Profiles**
- Chrome: Create separate profile for each account
- Firefox: Use containers or separate profile
- Edge: Use separate profiles

**Option 2: Incognito/Private Window**
```
1. Open Private/Incognito window (Ctrl+Shift+N or Cmd+Shift+N)
2. Go to http://localhost:3000
3. Create/login with different account
4. Normal window keeps your first account
5. Private window has the second account
```

**Option 3: Clear Browser Data**
```
1. Press Ctrl+Shift+Del
2. Select "Cookies and other site data"
3. Click "Clear data"
4. Login with different account
```

---

## 🎥 Account Features

### What You Can Do When Logged In

✅ **Upload Videos**
- Use "Upload" section in left sidebar
- Add title and description
- Video gets processed automatically

✅ **Like Videos**
- Click "Like" on any video
- Contributes to recommendations

✅ **Comment on Videos**
- View and post comments
- Comments count toward engagement

✅ **Get Better Recommendations**
- "For You" section shows personalized videos
- Based on your viewing history
- Click "Retrain Model" for instant update

✅ **Track Watch History**
- See what you watched
- Resume from where you left off
- "Continue Watching" section

✅ **Search History**
- Auto-saved searches
- Quick re-search from sidebar

### What You Can Do Without Login

✅ **Watch Videos**
- All "Ready" videos are public
- See views, likes, comments
- Streaming works for everyone

✅ **Browse Content**
- Home feed
- Trending videos
- Fresh uploads
- Search videos

❌ **Can't Do Without Login**
- Upload videos
- Like or comment
- Get personalized recommendations
- See your watch history

---

## 🛡️ Security Notes

### Token Storage

**JWT Token** (Your authentication proof):
- Stored in browser localStorage
- Sent in Authorization header with requests
- Valid for current session
- Invalidated when you logout

### Password Storage

**Backend (Never transmitted)**:
- Password is hashed with bcrypt (one-way encryption)
- Never stored in plain text
- Server doesn't know your original password
- Only hash is stored in database

### HTTPS (Production Only)

**Development**: HTTP is okay (localhost)
**Production**: Must use HTTPS!
- Encrypts token in transit
- Protects from man-in-the-middle attacks
- Required for security

---

## 🐛 Troubleshooting

### Problem: "Invalid credentials"
**Possible Issues**:
1. Typo in email or password
2. Got uppercase/lowercase wrong (emails are case-insensitive, passwords are case-sensitive)
3. Account doesn't exist

**Solution**:
- Double-check spelling
- Try a different account
- Create a new account if you forgot the password

### Problem: "Login works, but forgotten after refresh"
**Possible Issues**:
1. Browser localStorage disabled
2. Private/Incognito window cleared data on close
3. localStorage was manually cleared

**Solution**:
1. Check localStorage is enabled (F12 > Application)
2. Use regular window, not incognito
3. Login again - data will be saved

### Problem: "Can't create account - email exists"
**Solution**:
- Use a different email
- That email is already registered
- If you forgot that password, create new account with different email

### Problem: "Lost all accounts after docker rebuild"
**This happened because**: You ran `docker compose down -v`

**What that does**:
- Deletes the database
- All user accounts are gone
- All videos are gone

**Prevention**:
- Use `docker compose down` (without -v)
- Use `docker compose down -v` only when you want to delete EVERYTHING

**Recovery**:
- Create new accounts
- Re-upload videos
- Or restore from backup if available

---

## 📊 System Architecture

### How Login Works

```
┌─────────────────────────────────────────────────────────┐
│ FRONTEND (Your Browser)                                 │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ 1. User enters email & password                      │ │
│ │ 2. Click "Create Account" or "Sign In"              │ │
│ └─────────────────────────────────────────────────────┘ │
└──────────────────────┬──────────────────────────────────┘
                       │ HTTPS POST /auth/register or /auth/login
                       │ Body: { email, password }
                       ▼
┌─────────────────────────────────────────────────────────┐
│ API GATEWAY (Node.js)                                   │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ 3. Receive email & password                         │ │
│ │ 4. Hash password with bcrypt                        │ │
│ │ 5. Create JWT token                                 │ │
│ │ 6. Return token to frontend                         │ │
│ └─────────────────────────────────────────────────────┘ │
└──────────────────────┬──────────────────────────────────┘
                       │ JSON: { token, user: {id, email} }
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│ FRONTEND (Your Browser) - Receives Token               │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ 7. Store token in localStorage                      │ │
│ │ 8. Store user info in localStorage                  │ │
│ │ 9. Show logged-in UI                                │ │
│ │                                                     │ │
│ │ From now on, every API request includes:            │ │
│ │ Header: "Authorization: Bearer {token}"             │ │
│ └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘

        After Refresh/Restart:

┌─────────────────────────────────────────────────────────┐
│ FRONTEND (Browser starts)                               │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ 1. Load app                                         │ │
│ │ 2. Retrieve token from localStorage                 │ │
│ │ 3. Load user info from localStorage                 │ │
│ │ 4. Show logged-in UI                                │ │
│ │ 5. Optional: Verify token still valid with server   │ │
│ └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

---

## 💡 Pro Tips

### Remember Your Password
Most browsers ask if you want to save passwords:
1. After login, browser shows "Save password?"
2. Click "Save"
3. Next login, browser auto-fills
4. Very convenient!

### Test User Experiences
Create accounts for different use cases:
- Creator account (uploads videos)
- Viewer account (watches and comments)
- Admin account (manages system)

### Database Accounts
View all accounts (admin only):
```bash
docker exec scalastream-postgres psql -U scalastream -d scalastream -c "SELECT id, email, created_at FROM users;"
```

---

## 📞 Reference

**Default Database Credentials** (for developers):
- DB Host: `postgres` (or `localhost:5432`)
- Database: `scalastream`
- User: `scalastream`
- Password: `scalastream`

**Demo Accounts** (created automatically):
- `demo@example.com` / `demo123456`
- `test@example.com` / `password123`

---

## ✅ Checklist - First Time Setup

- [ ] Docker containers running (`docker compose ps`)
- [ ] Frontend loads at `http://localhost:3000`
- [ ] Create your account with "Create Account" button
- [ ] Confirm you're logged in (see your email in top right)
- [ ] Check localStorage has your token (F12 > Application > Local Storage)
- [ ] Refresh page - you should still be logged in!
- [ ] Try uploading a video
- [ ] Try browsing videos as guest (logout first)
- [ ] Everything working? Great! You're ready to go! 🎬

---

**Happy Streaming! 🎬**

Your credentials are safely stored and will persist across sessions!
