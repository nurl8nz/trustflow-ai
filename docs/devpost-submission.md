# Devpost submission draft

Edit freely before submitting. Replace the bracketed parts.

**Tagline:** AI turns vague freelance deals into clear milestones. PayPal holds each payment until the work is approved.

## Inspiration
[Your story as a freelancer and tutor: payments lost to vague agreements, no money for a lawyer.]

## What it does
You describe a deal the way you would text it. TrustFlow underlines the words that usually start arguments (“modern”, “after testing”, “be flexible”), asks one-line questions, and turns the answers into milestones with acceptance checks both sides can verify. A clarity score shows how close the deal is to dispute-proof.

When both sides accept, the client funds a milestone with PayPal. The money is authorized, not charged. The freelancer submits the work, the AI checks the delivery note against every acceptance check, and the client releases the payment with one click, which captures the authorization. Cancelled milestones void the hold. Milestones approved without a hold are billed with a PayPal invoice.

A payment agent built on Gemini function calling reads the agreement, checks live PayPal status, prepares invoices and proposes releases. It never moves money on its own: every money movement is an approval card a human approves.

## How we built it
- PayPal JavaScript SDK v6 for checkout, Orders API v2 with intent AUTHORIZE, Payments API v2 for capture and void, Invoicing API v2, verified webhooks, idempotent requests with PayPal-Request-Id.
- Google Gemini with structured JSON output for agreement analysis and delivery checks, and function calling for the payment agent.
- A dependency-free Node.js server, a vanilla JavaScript interface, and an end-to-end test suite that runs the full flow against PayPal and Gemini mocks.

## Challenges we ran into
Deciding how much power the AI should have over money. We let it explain, prepare and propose, and kept every capture, void and invoice behind a human approval. We also refused to trust raw model output: quotes are verified against the user’s text, amounts are recomputed in cents, and the clarity score is plain arithmetic.

## Accomplishments that we're proud of
[What you are proud of.]

## What we learned
[What you learned.]

## What's next for TrustFlow AI
Shareable links so each side uses their own device, PayPal multiparty payments for a marketplace version, reminders before a hold expires, and exporting the agreed terms.

## Built with
paypal-js-sdk-v6, paypal-orders-api, paypal-payments-api, paypal-invoicing-api, paypal-webhooks, google-gemini, node.js, javascript, html, css, render
