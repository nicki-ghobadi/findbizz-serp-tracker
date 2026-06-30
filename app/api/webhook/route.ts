import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { checkRankings, rankingsToCSV } from "@/lib/apify";
import {
  autoFulfill,
  sendVerificationFailureEmail,
  VerificationFailedError,
} from "@/lib/auto-fulfill";
import { crossVerifySerpResults } from "@/lib/cross-verify";
import { validateSerpResults, validationSummaryHtml } from "@/lib/fulfillment-validate";
import { getErrorMessage, requireEnv } from "@/lib/env";
import {
  markFailed,
  markPaidFromSession,
  markPaidFromSubscription,
} from "@/lib/orders";
import { escapeHtml, parseKeywordsJson, sanitizeFilename } from "@/lib/sanitize";
import { claimStripeEvent } from "@/lib/webhook-guard";
import { getStripe } from "@/lib/stripe";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_ATTEMPTS = 2;

export async function POST(req: NextRequest) {
  let orderId: string | undefined;

  try {
    const stripe = getStripe();
    requireEnv("APIFY_API_TOKEN");
    requireEnv("APIFY_ACTOR_ID");
    requireEnv("RESEND_API_KEY");
    requireEnv("RESEND_FROM_EMAIL");

    const body = await req.text();
    const sig = req.headers.get("stripe-signature");
    if (!sig) {
      return NextResponse.json({ error: "Missing Stripe signature" }, { status: 400 });
    }

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(body, sig, requireEnv("STRIPE_WEBHOOK_SECRET"));
    } catch {
      return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
    }

    if (
      event.type !== "checkout.session.completed" &&
      event.type !== "invoice.payment_succeeded"
    ) {
      return NextResponse.json({ received: true });
    }

    if (event.type === "invoice.payment_succeeded") {
      const invoice = event.data.object as Stripe.Invoice;
      if (invoice.billing_reason === "subscription_create") {
        return NextResponse.json({ received: true });
      }
    }

    let email: string | undefined;
    let domain: string | undefined;
    let keywords: string[] = [];
    let paymentStatus: string | null | undefined;

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      orderId = session.metadata?.orderId;
      paymentStatus = session.payment_status;
      email = session.metadata?.email;
      domain = session.metadata?.domain;
      keywords = parseKeywordsJson(session.metadata?.keywords);
    } else {
      const invoice = event.data.object as Stripe.Invoice;
      const sub = await stripe.subscriptions.retrieve(invoice.subscription as string);
      orderId = sub.metadata?.orderId;
      paymentStatus = "paid";
      email = sub.metadata.email;
      domain = sub.metadata.domain;
      keywords = parseKeywordsJson(sub.metadata.keywords);
    }

    const claimed = await claimStripeEvent({
      eventId: event.id,
      eventType: event.type,
      orderId,
    });
    if (!claimed) {
      return NextResponse.json({ received: true, duplicate: true });
    }

    if (paymentStatus && paymentStatus !== "paid") {
      return NextResponse.json({ received: true, skipped: "unpaid" });
    }

    if (event.type === "checkout.session.completed") {
      await markPaidFromSession(event.data.object as Stripe.Checkout.Session);
    } else if (orderId) {
      const invoice = event.data.object as Stripe.Invoice;
      const sub = await stripe.subscriptions.retrieve(invoice.subscription as string);
      await markPaidFromSubscription({
        orderId,
        subscriptionId: sub.id,
        customerId: typeof sub.customer === "string" ? sub.customer : null,
        amountCents: invoice.amount_paid ?? undefined,
      });
    }

    if (!email || !domain || !keywords.length || !orderId) {
      console.error("Missing subscription metadata", { email, domain, keywords });
      if (orderId) await markFailed(orderId, "Missing subscription metadata");
      return NextResponse.json({ received: true, error: "missing_metadata" });
    }

    const safeDomain = escapeHtml(domain);
    let lastError: VerificationFailedError | null = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const rawResults = await checkRankings(domain, keywords);
        const { items: results, report } = validateSerpResults(rawResults);
        const crossCheck = await crossVerifySerpResults(results, domain);
        const csv = rankingsToCSV(results);
        const ranked = results.filter((r) => r.position !== null).length;

        await autoFulfill({
          orderId,
          validationReport: report,
          crossCheckReport: crossCheck,
          aiSamples: results.slice(0, 8) as unknown as Record<string, unknown>[],
          fulfillment: {
            customerEmail: email,
            subject: `Your SERP report for ${domain} — ${ranked}/${results.length} keywords ranked`,
            htmlBody: `
              <div style="font-family: sans-serif; max-width: 560px;">
                <h2>Your weekly ranking report</h2>
                <p>Domain: <strong>${safeDomain}</strong></p>
                <p>${ranked} of ${results.length} tracked keywords appear in the top 30 on Google Canada.</p>
                <table style="width:100%;border-collapse:collapse;font-size:13px;">
                  <tr style="background:#f5f5f5;">
                    <th style="text-align:left;padding:8px;border:1px solid #ddd;">Keyword</th>
                    <th style="text-align:center;padding:8px;border:1px solid #ddd;">Position</th>
                  </tr>
                  ${results
                    .map(
                      (r) => `
                  <tr>
                    <td style="padding:8px;border:1px solid #ddd;">${escapeHtml(r.keyword)}</td>
                    <td style="text-align:center;padding:8px;border:1px solid #ddd;color:${r.position ? (r.position <= 10 ? "green" : "orange") : "red"}">
                      ${r.position ? `#${r.position}` : "Not ranked"}
                    </td>
                  </tr>`
                    )
                    .join("")}
                </table>
                <p style="font-size:12px;color:#888;margin-top:16px;">Full CSV attached. Sent monthly with your subscription.</p>
                ${validationSummaryHtml(report)}
              </div>
            `,
            csvFilename: sanitizeFilename(
              `serp-report-${domain}-${new Date().toISOString().split("T")[0]}.csv`
            ),
            csvContent: csv,
            rowCount: results.length,
          },
        });
        lastError = null;
        break;
      } catch (err) {
        if (err instanceof VerificationFailedError) {
          lastError = err;
          console.warn(`SERP verification attempt ${attempt + 1} failed:`, err.reasons);
          continue;
        }
        throw err;
      }
    }

    if (lastError) {
      await sendVerificationFailureEmail({
        customerEmail: email,
        productLabel: "SERP Tracker",
      });
      await markFailed(orderId, lastError.message);
      return NextResponse.json({ received: true, failed: true });
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    console.error("SERP report error:", err);
    if (orderId) {
      await markFailed(orderId, getErrorMessage(err, "Report generation failed")).catch(() => {});
    }
    return NextResponse.json({ received: true, error: "internal" });
  }
}
