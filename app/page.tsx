"use client";

import { useState } from "react";
import { EmailVerifyStep } from "@/components/email-verify-step";
import { LandingShell } from "@/components/landing-shell";
import {
  ErrorBox,
  FieldInput,
  FormHint,
  Label,
  SubmitButton,
} from "@/components/form-ui";
import { features, hero, theme } from "@/lib/theme";

export default function Home() {
  const [domain, setDomain] = useState("");
  const [email, setEmail] = useState("");
  const [confirmEmail, setConfirmEmail] = useState("");
  const [keywordInput, setKeywordInput] = useState("");
  const [keywords, setKeywords] = useState<string[]>([]);
  const [orderId, setOrderId] = useState("");
  const [step, setStep] = useState<"form" | "verify">("form");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  function addKeyword() {
    const kw = keywordInput.trim();
    if (!kw || keywords.includes(kw) || keywords.length >= 10) return;
    setKeywords([...keywords, kw]);
    setKeywordInput("");
  }

  function removeKeyword(kw: string) {
    setKeywords(keywords.filter((k) => k !== kw));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!domain || !email || !confirmEmail || keywords.length === 0) {
      setError("Fill in domain, both email fields, and add at least one keyword.");
      return;
    }
    if (email.trim().toLowerCase() !== confirmEmail.trim().toLowerCase()) {
      setError("Email addresses do not match.");
      return;
    }
    setError("");
    setLoading(true);

    const res = await fetch("/api/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, confirmEmail, domain, keywords }),
    });

    const data = await res.json();
    if (data.orderId) {
      setOrderId(data.orderId);
      setStep("verify");
      setLoading(false);
      return;
    }

    setError(data.error || "Something went wrong. Please try again.");
    setLoading(false);
  }

  return (
    <LandingShell
      productName={theme.productName}
      footer={theme.footer}
      accent={theme.accent}
      accentSoft={theme.accentSoft}
      accentBorder={theme.accentBorder}
      glow={theme.glow}
      badge={hero.badge}
      headline={hero.headline}
      accentIndex={hero.accentIndex}
      description={hero.description}
      price={hero.price}
      featuresTitle={features.title}
      features={features.items}
      trustItems={hero.trustItems}
    >
      {step === "verify" ? (
        <EmailVerifyStep
          theme={theme}
          email={email}
          orderId={orderId}
          checkoutPath="/api/subscribe"
          submitLabel="Continue to payment — $29 CAD/month"
          onBack={() => {
            setStep("form");
            setOrderId("");
          }}
        />
      ) : (
        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <Label>Your domain</Label>
            <FieldInput
              theme={theme}
              type="text"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="yourwebsite.com"
            />
          </div>

          <div>
            <Label>Keywords to track (up to 10)</Label>
            <div className="flex gap-2">
              <FieldInput
                theme={theme}
                type="text"
                value={keywordInput}
                onChange={(e) => setKeywordInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addKeyword())}
                placeholder="e.g. dentist Toronto"
                className="flex-1"
              />
              <button
                type="button"
                onClick={addKeyword}
                disabled={keywords.length >= 10}
                className="shrink-0 rounded-xl border border-white/10 bg-white/5 px-4 text-sm font-medium text-white/70 transition hover:bg-white/10 disabled:opacity-40"
              >
                Add
              </button>
            </div>
            {keywords.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {keywords.map((kw) => (
                  <span
                    key={kw}
                    className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium"
                    style={{
                      backgroundColor: theme.accentSoft,
                      color: theme.accent,
                      border: `1px solid ${theme.accentBorder}`,
                    }}
                  >
                    {kw}
                    <button
                      type="button"
                      onClick={() => removeKeyword(kw)}
                      className="opacity-60 hover:opacity-100"
                      aria-label={`Remove ${kw}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div>
            <Label>Your email</Label>
            <FieldInput
              theme={theme}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
            />
          </div>

          <div>
            <Label>Confirm email</Label>
            <FieldInput
              theme={theme}
              type="email"
              value={confirmEmail}
              onChange={(e) => setConfirmEmail(e.target.value)}
              placeholder="you@company.com"
            />
          </div>

          {error && <ErrorBox message={error} />}

          <SubmitButton theme={theme} loading={loading}>
            {loading ? "Sending verification code…" : "Verify email & continue — $29 CAD/month"}
          </SubmitButton>

          <FormHint>{hero.delivery}</FormHint>
        </form>
      )}
    </LandingShell>
  );
}
