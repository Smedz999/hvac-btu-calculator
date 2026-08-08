# MongoDB Setup Guide for ACConnx

## Quick Start (5 minutes)

### 1. Create MongoDB Atlas Account
1. Go to https://www.mongodb.com/atlas
2. Click "Try Free"
3. Sign up with email or Google

### 2. Create a Cluster
1. Choose **FREE** tier (M0 Sandbox)
2. Select a region close to you (London for UK)
3. Name it `acconnx-cluster`
4. Click "Create Cluster" (takes 1-3 minutes)

### 3. Create Database User
1. Go to **Database Access** (left sidebar)
2. Click "Add New Database User"
3. Username: `acconnx-admin`
4. Password: Generate a strong password (save it!)
5. Database User Privileges: **Atlas Admin**
6. Click "Add User"

### 4. Whitelist IP Address
1. Go to **Network Access** (left sidebar)
2. Click "Add IP Address"
3. Click "Allow Access from Anywhere" (0.0.0.0/0)
   - *Note: For production, restrict to Vercel's IPs*
4. Click "Confirm"

### 5. Get Connection String
1. Go to **Database** (left sidebar)
2. Click "Connect" on your cluster
3. Choose "Connect your application"
4. Copy the connection string (looks like):
   ```
   mongodb+srv://acconnx-admin:<password>@acconnx-cluster.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```

### 6. Add to Vercel
1. Go to your Vercel project dashboard
2. Settings → Environment Variables
3. Add:
   - Name: `MONGODB_URI`
   - Value: Your connection string (replace `<password>` with actual password)
4. Redeploy

## Local Development (Optional)

If you want to test locally:

```bash
# Install MongoDB locally (macOS)
brew install mongodb-community

# Start MongoDB
brew services start mongodb-community

# Or use Docker
docker run -d -p 27017:27017 --name mongodb mongo:latest
```

Then set in `.env`:
```
MONGODB_URI=mongodb://localhost:27017/acconnx
```

## What This Fixes

- ✅ Data persists between deployments
- ✅ No more lost leads/companies
- ✅ Scales to thousands of users
- ✅ Free tier: 512MB storage (plenty for start)

## Migration

The API will automatically create collections on first run. No manual migration needed.

## Need Help?

If you get stuck, send me a screenshot of where you're stuck and I'll guide you.
