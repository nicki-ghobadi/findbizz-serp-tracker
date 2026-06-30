import { NextRequest, NextResponse } from "next/server";
import { createOrder } from "@/lib/orders";
import { getErrorMessage } from "@/lib/env";
import { clientIp, enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { clampString, isValidDomain, parseKeywords } from "@/lib/sanitize";
import { UserFacingError } from "@/lib/user-error";
import { emailsMatch, isValidEmail, normalizeEmail } from "@/lib/validate-email";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = normalizeEmail(body.email);
    const confirmEmail = normalizeEmail(body.confirmEmail);
    const domain = clampString(body.domain, 253).toLowerCase();
    const keywords = parseKeywords(body.keywords, 10);

    if (!email || !confirmEmail || !domain || !keywords.length) {
      return NextResponse.json({ error: "Fill in domain, keywords, and both email fields." }, { status: 400 });
    }

    if (!isValidEmail(email)) {
      return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
    }

    if (!emailsMatch(email, confirmEmail)) {
      return NextResponse.json({ error: "Email addresses do not match." }, { status: 400 });
    }

    if (!isValidDomain(domain)) {
      return NextResponse.json({ error: "Enter a valid domain (e.g. example.com)." }, { status: 400 });
    }

    await enforceRateLimit(`request:ip:${clientIp(req)}`, RATE_LIMITS.requestByIp);
    await enforceRateLimit(`request:email:${email}`, RATE_LIMITS.requestByEmail);

    const { orderId } = await createOrder({
      email,
      requestPayload: { domain, keywords },
      orderType: "subscription",
    });

    return NextResponse.json({ orderId, email });
  } catch (err) {
    console.error("Request error:", err);
    const status = err instanceof UserFacingError ? 429 : 500;
    return NextResponse.json(
      { error: getErrorMessage(err, "Unable to start your request. Please try again.") },
      { status }
    );
  }
}
