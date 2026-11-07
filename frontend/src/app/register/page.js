"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import styles from "../login/page.module.css";

export default function RegisterPage() {
  const router = useRouter();
  const { register, login } = useAuth();
  const [form, setForm] = useState({ name: "", email: "", password: "", age: "", gender: "", avatar: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleChange = (e) => {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
    setError("");
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      await register({ ...form, age: Number(form.age) });
      await login(form.email, form.password);
      router.push("/products");
    } catch (err) {
      setError(err.message || "Sign up failed. Please check your details and try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.imageSide}>
        <img
          src="https://images.unsplash.com/photo-1490481651871-ab68de25d43d?auto=format&fit=crop&q=80&w=1200"
          alt="Fashion editorial"
          className={styles.bgImage}
        />
        <div className={styles.imageOverlay} />
        <div className={styles.imageQuote}>
          <p className={styles.quoteText}>&ldquo;Fashion is the armor to survive the reality of everyday life.&rdquo;</p>
          <span className={styles.quoteAuthor}>— Bill Cunningham</span>
        </div>
      </div>

      <div className={styles.formSide}>
        <div className={styles.formContainer}>
          <Link href="/" className={styles.logoBack}><em>MAREN</em></Link>

          <div className={styles.header}>
            <p className={styles.stepLabel}>NO. 07 — NEW MEMBER</p>
            <h1 className={styles.title}>Join the<br /><em>inner circle.</em></h1>
            <p className={styles.subtitle}>Create your account and discover curated fashion.</p>
          </div>

          {error && <div className="alert alert-error animate-fade-in">{error}</div>}

          <form onSubmit={handleRegister} className={styles.form}>
            <div className={styles.row}>
              <div className="form-group">
                <label className="form-label" htmlFor="name">Full Name</label>
                <input id="name" name="name" type="text" className="form-input" placeholder="Jane Doe"
                  value={form.name} onChange={handleChange} required />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="age">Age</label>
                <input id="age" name="age" type="number" className="form-input" placeholder="25"
                  value={form.age} onChange={handleChange} min="14" max="120" required />
              </div>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="reg-email">Email Address</label>
              <input id="reg-email" name="email" type="email" className="form-input" placeholder="your@email.com"
                value={form.email} onChange={handleChange} required />
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="reg-password">Password</label>
              <input id="reg-password" name="password" type="password" className="form-input" placeholder="Min. 6 characters"
                value={form.password} onChange={handleChange} required minLength={6} />
            </div>

            <div className={styles.row}>
              <div className="form-group">
                <label className="form-label" htmlFor="gender">Gender</label>
                <select id="gender" name="gender" className="form-select" value={form.gender} onChange={handleChange} required>
                  <option value="" disabled>Select</option>
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                  <option value="not to say">Prefer not to say</option>
                </select>
              </div>
            </div>

            <button type="submit" className={styles.submitBtn} disabled={loading}>
              {loading ? (
                <><span className="spinner" style={{ width: 16, height: 16 }} /> CREATING ACCOUNT...</>
              ) : "SIGN UP →"}
            </button>
          </form>

          <div className={styles.footer}>
            <p>Already have an account?{" "}
              <Link href="/login" className={styles.footerLink}>Sign in →</Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
