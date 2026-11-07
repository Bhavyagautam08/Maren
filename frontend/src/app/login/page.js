"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import styles from "./page.module.css";

const demoEmail = process.env.NEXT_PUBLIC_DEMO_EMAIL || "";
const demoPassword = process.env.NEXT_PUBLIC_DEMO_PASSWORD || "";

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  const [form, setForm] = useState({
    email: demoEmail,
    password: demoPassword,
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleChange = (e) => {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
    setError("");
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      await login(form.email, form.password);
      router.push("/products");
    } catch (err) {
      setError(err.message || "Login failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.page}>
      {/* Background image side */}
      <div className={styles.imageSide}>
        <img
          src="https://images.unsplash.com/photo-1581044777550-4cfa60707c03?auto=format&fit=crop&q=80&w=1200"
          alt="Fashion editorial"
          className={styles.bgImage}
        />
        <div className={styles.imageOverlay} />
        <div className={styles.imageQuote}>
          <p className={styles.quoteText}>&ldquo;Style is a way to say who you are without having to speak.&rdquo;</p>
          <span className={styles.quoteAuthor}>— Rachel Zoe</span>
        </div>
      </div>

      {/* Form side */}
      <div className={styles.formSide}>
        <div className={styles.formContainer}>
          <Link href="/" className={styles.logoBack}>
            <em>MAREN</em>
          </Link>

          <div className={styles.header}>
            <p className={styles.stepLabel}>NO. 06 — MEMBER ACCESS</p>
            <h1 className={styles.title}>Welcome<br /><em>back.</em></h1>
            <p className={styles.subtitle}>Sign in to your account to continue.</p>
          </div>

          {error && (
            <div className="alert alert-error animate-fade-in">
              {error}
            </div>
          )}

          {demoEmail && demoPassword && (
            <p className={styles.demoNote}>
              Demo account: credentials are pre-filled. Just click Login.
            </p>
          )}

          <form onSubmit={handleSubmit} className={styles.form}>
            <div className="form-group">
              <label className="form-label" htmlFor="email">Email Address</label>
              <input
                id="email"
                name="email"
                type="email"
                className="form-input"
                placeholder="your@email.com"
                value={form.email}
                onChange={handleChange}
                required
                autoComplete="email"
              />
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="password">Password</label>
              <input
                id="password"
                name="password"
                type="password"
                className="form-input"
                placeholder="••••••••"
                value={form.password}
                onChange={handleChange}
                required
                autoComplete="current-password"
              />
            </div>

            <button type="submit" className={styles.submitBtn} disabled={loading}>
              {loading ? (
                <><span className="spinner" style={{ width: 16, height: 16 }} /> Signing in...</>
              ) : "SIGN IN →"}
            </button>
          </form>

          <div className={styles.footer}>
            <p>Don&apos;t have an account?{" "}
              <Link href="/register" className={styles.footerLink}>Create one →</Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
