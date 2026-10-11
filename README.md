# Maren — Full-Stack E-Commerce Platform

A modern, full-stack e-commerce application built with **Next.js 16**, **Express.js**, and **MongoDB**.

---

##  Features

- OTP-based email verification on sign-up
- JWT authentication with access & refresh tokens
- Product listing, filtering, and detail pages
- Shopping cart with real-time quantity management
- Order placement and order history
- Admin panel for product & order management
- Responsive, glassmorphism-inspired UI

---

## 🗂️ Project Structure

```
ecommerce/
├── backend/       # Express.js REST API
└── frontend/      # Next.js 16 App Router
```

---

##  Getting Started (Local Development)

### Prerequisites
- Node.js 18+
- A MongoDB Atlas cluster (free tier works)
- A Gmail account with an [App Password](https://support.google.com/accounts/answer/185833) for SMTP

### 1. Backend Setup

```bash
cd backend
cp .env.example .env
# Fill in your .env values (see .env.example)
npm install
npm run dev
```

The API will be available at `http://localhost:5000`.

To populate the catalog with at least 1,000 products and multi-image galleries, set
`MONGO_URI` in `backend/.env` and run this from the `backend/` directory:

```bash
npm run seed
```

The default target is 1,000 products. For a larger local/benchmark catalog, set
`SEED_COUNT=100000` in `backend/.env` and run `npm run seed`. Check MongoDB
storage limits before seeding large datasets, especially on free-tier clusters.

The seed command is repeatable and preserves existing products; it adds only
missing catalog entries and refreshes galleries for the original sample items.

### 2. Frontend Setup

```bash
cd frontend
cp .env.example .env.local
# Fill in NEXT_PUBLIC_API_URL=http://localhost:5000/api/v1
npm install
npm run dev
```

The app will be available at `http://localhost:3000`.

---

## ⚙️ Environment Variables

### Backend (`backend/.env`)

| Variable | Description |
|---|---|
| `PORT` | Server port (default: 5000) |
| `MONGO_URI` | MongoDB Atlas connection string |
| `JWT_SECRET` | Secret for signing access tokens |
| `REFRESH_TOKEN_SECRET` | Secret for signing refresh tokens |
| `REDIS_ENABLED` | Set to `false` to bypass Redis-backed caching locally; defaults to enabled |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST URL (`https://...upstash.io`) |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST token |
| `CLIENT_URL` | Primary frontend origin allowed by CORS |
| `CLIENT_URLS` | Optional comma-separated additional frontend origins |
| `SMTP_EMAIL` | Gmail address for sending OTPs |
| `SMTP_PASSWORD` | Gmail App Password |

### Frontend (`frontend/.env.local`)

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_API_URL` | Full base URL of the backend API |

---

## 🌐 Deployment

### Backend → [Render](https://render.com)

1. Create a new **Web Service** pointing to the `backend/` directory.
2. Set **Build Command**: `npm install`
3. Set **Start Command**: `node server.js`
4. Add all environment variables from `backend/.env.example`.
5. Set `CLIENT_URL` to your primary Vercel frontend origin. Add preview origins
   to `CLIENT_URLS` as a comma-separated list when needed.
6. Run `npm run seed` from `backend/` with the production `MONGO_URI` to populate
   the catalog; the seed command does not delete existing products.

### Frontend → [Vercel](https://vercel.com)

1. Import the repo, set **Root Directory** to `frontend/`.
2. Set `NEXT_PUBLIC_API_URL` to your Render backend URL (e.g. `https://your-api.onrender.com/api/v1`).
3. Add the variable to the Vercel project's Production (and Preview, if used)
   environment, then deploy or redeploy. Do not commit deployment credentials
   or local `.env` files.
4. If the GitHub repository is connected to Vercel, pushes to the configured
   production branch trigger a frontend deployment. Backend changes still need
   to be deployed by the backend host (for example, Render).

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16, React 19, CSS Modules |
| Backend | Node.js, Express.js 5 |
| Database | MongoDB Atlas + Mongoose |
| Auth | JWT (access + refresh tokens) |
| Cache / OTP | Redis |
| Email | Nodemailer + Gmail SMTP |
| Validation | Zod |
