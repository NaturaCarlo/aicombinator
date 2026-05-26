# AI Agent Payments: Comprehensive Research (Feb 2026)

## Table of Contents
1. [The Three Payment Protocols (The Big Picture)](#1-the-three-payment-protocols)
2. [Crypto-to-Fiat Gateways](#2-crypto-to-fiat-gateways)
3. [Agent Payment Platforms & Infrastructure](#3-agent-payment-platforms--infrastructure)
4. [Virtual Card Providers for Agents](#4-virtual-card-providers-for-agents)
5. [Card Network Frameworks (Visa & Mastercard)](#5-card-network-frameworks)
6. [How Agents Pay for Things](#6-how-agents-pay-for-things)
7. [How Agents Receive Payment](#7-how-agents-receive-payment)
8. [KYC & Compliance](#8-kyc--compliance)
9. [Crypto-Funded Virtual Cards](#9-crypto-funded-virtual-cards)
10. [Quick Reference: All Products & Links](#10-quick-reference)

---

## 1. The Three Payment Protocols

Three competing (but complementary) open standards have emerged for AI agent payments. They operate at different layers and can coexist:

### ACP - Agentic Commerce Protocol (Stripe + OpenAI)
- **What:** Open standard for checkout flows between buyers, AI agents, and merchants
- **License:** Apache 2.0, open source
- **Key Innovation:** Shared Payment Tokens (SPTs) - scoped, programmable payment credentials
- **Live Product:** Instant Checkout in ChatGPT (US users buying from Etsy, soon 1M+ Shopify merchants)
- **SDK:** Stripe Agent Toolkit (Python/TypeScript), supports LangChain, OpenAI Agents SDK, Vercel AI SDK, CrewAI
- **Install:** `npm install @stripe/agent-toolkit` or `pip install stripe-agent-toolkit`
- **Integration:** If already on Stripe, enable agentic payments with as little as 1 line of code change
- **Spec:** https://developers.openai.com/commerce/ | https://agenticcommerce.dev
- **GitHub:** https://github.com/agentic-commerce-protocol/agentic-commerce-protocol
- **How it works:** Agent creates checkout session -> merchant returns cart state -> user approves -> agent provisions SPT -> merchant processes PaymentIntent
- **Merchant of record:** The merchant (not OpenAI/Stripe)
- **Fees:** Small fee on purchases (refunded on returns). Free to be discovered.

### AP2 - Agent Payments Protocol (Google Cloud)
- **What:** Open protocol for secure, auditable agent-initiated payments
- **License:** Apache 2.0
- **Key Innovation:** Verifiable Credentials (Mandates) - cryptographically signed proof of user intent
- **Partners:** 60+ organizations including Mastercard, Adyen, PayPal, Coinbase, Accenture, Nexi, Okta, 1Password
- **Three Mandate Types:** Intent Mandate -> Cart Mandate -> Payment Mandate
- **Modes:** Human-Present (real-time approval) and Human-Not-Present (delegated with pre-signed limits)
- **Payment Methods:** Credit/debit cards, bank transfers, crypto (via A2A x402 extension with Coinbase/Ethereum Foundation/MetaMask)
- **Spec:** https://ap2-protocol.org/specification/
- **GitHub:** https://github.com/google-agentic-commerce/AP2
- **Samples:** Python and Android scenarios using Agent Development Kit (ADK) + Gemini 2.5 Flash

### x402 Protocol (Coinbase)
- **What:** Internet-native payment protocol using HTTP 402 status code for machine-to-machine payments
- **License:** Open standard
- **Key Innovation:** Embeds payment directly into HTTP requests - no accounts, subscriptions, or API keys needed
- **Battle-tested:** 50M+ transactions
- **How it works:** Client requests resource -> Server returns 402 with payment instructions -> Client pays in USDC on-chain -> Client retries with X-PAYMENT header -> Server verifies & grants access
- **SDK Packages (npm):**
  - Client: `@x402/core @x402/evm @x402/svm @x402/fetch` (or `@x402/axios`)
  - Server: `@x402/core @x402/evm @x402/svm @x402/express` (or `@x402/hono` / `@x402/next`)
  - Paywall: `@x402/paywall`
- **GitHub:** https://github.com/coinbase/x402
- **Product page:** https://www.coinbase.com/developer-platform/products/x402
- **Networks:** EVM chains + Solana, with Base L2 as primary (near-instant, sub-cent fees)
- **Early Adopter Example:** CoinGecko API - $0.01 USDC per request, no account/API key required

### How They Compare
| Feature | ACP (Stripe/OpenAI) | AP2 (Google) | x402 (Coinbase) |
|---------|---------------------|--------------|-----------------|
| **Focus** | Checkout & merchant integration | Trust, authorization, audit | Machine-to-machine micropayments |
| **Payment Rails** | Fiat (cards via Stripe) | Fiat + Crypto | Crypto (USDC stablecoins) |
| **Best For** | E-commerce, retail | Enterprise compliance | API monetization, M2M |
| **Human Required?** | Yes (approval step) | Optional (delegated mode) | No |
| **Micropayments** | No | Not primary focus | Yes (sub-cent) |
| **Live Product** | ChatGPT Instant Checkout | Demos/samples | CoinGecko, Zuplo, others |

**They are complementary:** A large enterprise might use ACP for shopping, AP2 for governance/audit, and x402 for machine-to-machine data access.

---

## 2. Crypto-to-Fiat Gateways

### For Programmatic Agent Use

| Provider | Fee | Fiat Currencies | Key Feature | API? |
|----------|-----|-----------------|-------------|------|
| **NOWPayments** | 0.5% mono / 1% conversion | 75+ | Mass payouts, 1000 tx/batch, sandbox | Yes |
| **CoinGate** | ~1% | EUR/GBP/USD | Instant settlement, EU compliance | Yes |
| **BitPay** | 1% | USD/EUR + more | Enterprise-grade, used by Microsoft/AMC | Yes |
| **CoinRemitter** | 0.23% | Multiple | Lowest fees, open-source plugins | Yes |
| **Transak** | Varies | 100+ fiat | On/off-ramp aggregator, KYC built-in | Yes |
| **Onramper** | Varies (aggregator) | Multiple | Aggregates 30+ on-ramps, auto-selects best | Yes |
| **Request Finance** | Varies | Multiple | Crypto-to-fiat API, few lines of code | Yes |
| **Rise Works** | Varies | USD/CAD/EUR+ | USDC-to-fiat payroll, compliance built-in | Yes |

### Stripe x402 Integration (NEW - Feb 2026)
- Stripe now supports x402 payments on Base network
- AI agents pay with USDC, merchants receive funds in their Stripe balance (fiat)
- In preview as of Feb 11, 2026
- Agent-specific pricing plans available alongside traditional subscriptions
- Sales tax, refunds, reporting handled via standard Stripe tooling
- Developer CLI: `purl` (open-source command-line tool)
- Example integrations in Python and Node.js

---

## 3. Agent Payment Platforms & Infrastructure

### Coinbase AgentKit + Agentic Wallets
- **What:** Toolkit to give any AI agent a crypto wallet + onchain interactions
- **Launched:** AgentKit Nov 2024, Agentic Wallets Feb 11, 2026
- **Framework-agnostic:** Works with any AI framework (LangChain, OpenAI, Claude, Llama)
- **Wallet-agnostic:** Works with any wallet type
- **Networks:** EVM chains + Solana, gasless on Base L2
- **Setup:**
  ```bash
  npm create onchain-agent@latest  # TypeScript (generates NextJS app or MCP server)
  # or Python CLI for local chatbot
  ```
- **Install:** `npm install @coinbase/agentkit @coinbase/agentkit-langchain`
- **Agentic Wallet Setup:** `npx awal` (wallet in under 2 minutes)
- **Pre-built skills:** authenticate, fund, send, trade, earn
- **Security:** Session caps, per-transaction ceilings, private keys in secure enclaves (never exposed to agent/LLM)
- **GitHub:** https://github.com/coinbase/agentkit
- **Docs:** https://docs.cdp.coinbase.com/agent-kit/getting-started/quickstart

### Skyfire (KYAPay Protocol)
- **What:** Payment network built specifically for AI agents
- **Funding:** $9.5M raised, ~30 launch partners (APIFY, CarbonArc, BuildShip, Forter)
- **CEO:** Amir Sarhangi
- **Protocol:** KYAPay - identity-linked payment protocol for agent-to-agent/agent-to-service
- **How KYA Identity Works:** Lightweight JWT (JSON Web Token) containing:
  - Who is making the request (the agent)
  - Who is responsible (user/org behind the agent)
  - Valid payment method with sufficient balance
- **Compatibility:** OAuth2, MCP, ACP, A2A
- **Integration:** REST APIs + SDKs (Node, Python, Go), ~15 minutes to integrate
- **Features:**
  - Microtransactions below $5 (on-chain or off-chain)
  - Granular spending controls per transaction/time period/service provider
  - Just-in-time decisioning for high-value transactions
  - Visa integration demo (Dec 2025): Agent shops for headphones, compares via Consumer Reports, buys on Bose.com
- **GitHub:** https://github.com/skyfire-xyz/kyapay
- **Website:** https://skyfire.xyz
- **Pricing:** Contact for details; no-code monetization available for service providers

### Nevermined
- **What:** AI billing and payments infrastructure for usage-based agent commerce
- **Founded:** 2022
- **Key Problem Solved:** Sub-cent micropayments that traditional processors can't handle economically
- **Platform Fee:** Free to create Payment Plans; 1% fee on sales
- **Settlement Speed:** 200ms (vs. 2-3 days for traditional processors)
- **SDK:** TypeScript and Python, setup in under 20 minutes
- **Protocol Support:** MCP, Google A2A, x402, any HTTP-based protocol
- **Networks:** Arbitrum, Base, Polygon, Gnosis, Optimism, PEAQ, Celo
- **Pricing Models Supported:**
  - Usage-based (per-token, per-API-call, per-GPU-cycle)
  - Outcome-based (charge for results)
  - Flex Credits (prepaid consumption units)
  - Dynamic pricing (auto-adjust based on volume/segments/market)
- **Identity:** Nevermined ID (wallet + DID, persistent across environments)
- **Security:** Smart contracts enforce spending limits; session keys with scoped permissions
- **Real-world:** Valory cut billing infrastructure deployment from 6 weeks to 6 hours
- **Docs:** https://docs.nevermined.app
- **Website:** https://nevermined.ai

### Circle (USDC Infrastructure)
- **What:** USDC stablecoin issuer with programmable wallets for AI agents
- **Integration:** Developer-Controlled Wallets integrated with x402 protocol
- **How it works:** AI agent requests data -> service returns 402 -> agent pays USDC -> access granted
- **Demo:** LangChain-based agent (GPT-4o Mini) autonomously paid for blockchain wallet risk profile
- **Capabilities:** Micropayments down to cents or less; API monetization; escrow systems
- **AI Escrow:** Parse PDF contracts, extract terms, deploy smart contracts, verify work via image analysis, auto-settle
- **AP2 Participation:** Contributing alongside Coinbase, Ethereum Foundation, MetaMask
- **Website:** https://www.circle.com
- **Blog:** https://www.circle.com/blog/autonomous-payments-using-circle-wallets-usdc-and-x402

### PayPal Agent Toolkit
- **What:** Library for integrating PayPal APIs into AI agent workflows
- **Supported Frameworks:** Amazon Bedrock, CrewAI, LangChain, MCP, OpenAI Agents SDK, Vercel AI SDK
- **Languages:** Python, TypeScript
- **Install:** `pip install paypal-agent-toolkit` (v1.8.0)
- **Capabilities:** Orders, invoices, disputes, shipment tracking, catalog, subscriptions, reporting
- **MCP Server:** Industry's first remote MCP server with cloud authentication
- **Partnership:** OpenAI + PayPal for instant checkout in ChatGPT
- **AP2:** Partner in Google's AP2 initiative
- **GitHub:** https://github.com/paypal/agent-toolkit
- **Quickstart:** https://www.paypal.ai/docs/tools/agent-toolkit-quickstart
- **Website:** https://paypal.ai

### Crossmint (Agentic Finance Platform)
- **What:** Enterprise-grade wallet infrastructure + commerce APIs for AI agents
- **Funding:** $23.6M (March 2025), led by Ribbit Capital, Franklin Templeton, Nyca
- **Users:** 40,000+; clients include Adidas, Red Bull, MoneyGram, WireX, Toku
- **Four Pillars:**
  1. **Agent Wallets:** Non-custodial, dual-key architecture, programmable guardrails
  2. **World Store:** API access to 1B+ real-world SKUs, payments via major tokens on 40+ chains
  3. **GOAT SDK:** Open-source, 250+ onchain actions, 40+ blockchains (MIT license)
  4. **Credentials:** Authorization tools for agents acting on users' behalf
- **MCP Checkout:** Agents purchase from 1B+ items without virtual debit cards or browser automation
- **Compliance:** PCI, sales tax, merchant-of-record handled by Crossmint (not agent developer)
- **GitHub:** https://github.com/Crossmint/crossmint-agentic-finance
- **Docs:** https://docs.crossmint.com/solutions/ai-agents/introduction
- **Website:** https://www.crossmint.com/solutions/agentic-finance

### Stripe Agentic Commerce Suite (Dec 2025)
- **What:** Complete solution for selling through AI agents
- **Components:** Product discovery, checkout simplification, agentic payment acceptance
- **Distribution:** Stripe Dashboard/APIs, Shopify, Wix, WooCommerce, BigCommerce, Squarespace, commercetools
- **Early Adopters:** URBN (Anthropologie, Free People, Urban Outfitters), Etsy, Ashley Furniture, Coach, Kate Spade, Revolve, Halara
- **Stats:** Stripe powers 78% of Forbes AI 50; 700+ AI agent startups launched on Stripe in 2024
- **Pricing:** Usage-based billing (UBB) available for per-query, subscription, or outcome-based models
- **Docs:** https://docs.stripe.com/agentic-commerce

---

## 4. Virtual Card Providers for Agents

### API-Based Virtual Card Issuers

| Provider | Pricing | Key Feature | Crypto Funding? | Best For |
|----------|---------|-------------|-----------------|----------|
| **Stripe Issuing** | $0.10/virtual card, 2.9%+$0.30/tx | Real-time auth webhooks, PCI compliance | No (fiat only) | Developers already on Stripe |
| **Marqeta** | Interchange-based + platform fees | Open API, sandbox, $84B quarterly volume | Via partners | Enterprise card programs |
| **Lithic** | ~$0.05/card, no monthly fees, interchange share | Originally Privacy.com; flexible APIs | Via partners | Startups, fintech |
| **Galileo** | Contact for pricing | BIN sponsorship, white-label programs | Via partners | Banks, large programs |
| **Buvei** | Contact for pricing | USDT top-ups, crypto business focus | **Yes (USDT)** | Crypto-native businesses |
| **Extend** | Contact for pricing | Virtual credit card APIs, most flexible | No | Corporate expense management |
| **Qolo** | Contact for pricing | Customizable programs, spend controls | Via partners | Mid-market |
| **FreeBNK** | Contact for pricing | No traditional bank required | **Yes** | Web3/DeFi |

### How an Agent Would Use Virtual Cards
1. Agent calls card issuing API (e.g., Stripe Issuing `POST /v1/issuing/cards`)
2. Receives virtual card number, CVV, expiry
3. Sets spending limits, merchant category restrictions
4. Uses card to pay for services online
5. Monitors transactions via webhooks

### The Problem with Virtual Cards for Agents
- **KYC requirement:** All card issuers require a cardholder identity (KYC/KYB)
- **Not truly autonomous:** An agent cannot create a card without a verified human/business behind it
- **Better alternatives exist:** x402, Crossmint World Store, and Skyfire Agent Checkout eliminate the need for card-based checkout entirely

---

## 5. Card Network Frameworks

### Visa Trusted Agent Protocol
- **Launched:** October 2025, with 10+ partners
- **Developed with:** Cloudflare
- **What it does:** Enables merchants to distinguish legitimate AI agents from malicious bots
- **How:** Agent Providers are certified/onboarded by payment networks; verified via Web Bot Auth
- **Merchant integration:** Minimal changes to existing web infrastructure (HTTP-based)
- **Interoperable with:** ACP (OpenAI), x402 (Coinbase)
- **Milestone:** By Dec 2025, hundreds of secure agent-initiated transactions completed
- **Stats:** 47% of US shoppers now use AI for at least one shopping task
- **Spec:** https://developer.visa.com/capabilities/trusted-agent-protocol
- **Available on:** Visa Developer Center + GitHub

### Mastercard Agent Pay Acceptance Framework
- **Launched:** April 2025
- **Key Partners:** Microsoft (Azure OpenAI, Copilot Studio), IBM (watsonx), Braintree, Checkout.com
- **How it works:**
  1. Web Bot Auth (IETF RFC 9421) verifies agent identity at CDN layer - NO CODE REQUIRED
  2. Verified agents submit Dynamic Token Verification Code (agentic token) through standard card payment fields
  3. Includes purchase intent data, transaction limits, validity windows, audit trail
- **Scale:** Millions of Mastercard-accepting merchants can identify trusted agents
- **Evolution:** No-code -> deeper protocol integrations (MCP, A2A, ACP)
- **Infrastructure partner:** Cloudflare (for Web Bot Auth)
- **Also adopted by:** Fiserv (one of first major processors at scale), American Express (planning adoption)

---

## 6. How Agents Pay for Things

### Paying for API Keys & Services
| Method | How It Works | Example |
|--------|-------------|---------|
| **x402 (best for micropayments)** | Agent sends USDC per-request, no API key needed | CoinGecko: $0.01/request |
| **Stripe x402** | Agent pays USDC on Base, merchant gets fiat in Stripe balance | Any Stripe-enabled API |
| **Agentic Wallet (Coinbase)** | Agent holds USDC, pays autonomously with spending caps | Any x402-enabled service |
| **Skyfire** | Agent uses KYA JWT token + linked payment method | 30+ partner services |
| **Nevermined** | Agent uses credits/subscription via SDK auth | AI-to-AI marketplaces |
| **Virtual Card** | Agent uses programmatically-issued card details | Any online merchant |
| **PayPal Agent Toolkit** | Agent creates orders via PayPal API | Any PayPal-enabled service |

### Paying for Compute & Hosting
- **x402 + Coinbase Agentic Wallets:** Agent pays per-minute for GPU compute, per-query for data
- **Kite AI:** "The first AI payment blockchain" - instant, near-zero-fee machine-native value transfers
- **Algorand:** Settlement layer for x402 - speed, low cost, trust
- **Practical example:** Research agent pays per-article for financial data, per-query for market signals, per-minute for GPU compute - all without human approval

### Self-Sustaining Agent Example
An AI content creator that:
1. Earns USDC for its outputs (via x402 or Nevermined)
2. Pays for its own hosting (via Agentic Wallet)
3. Pays for API access to data sources (via x402 micropayments)
4. Reinvests in better tools (via programmable spending rules)

---

## 7. How Agents Receive Payment

### Methods for Agent Income

| Method | Platform | How It Works |
|--------|----------|-------------|
| **x402 Paywall** | Coinbase x402 | Agent runs API/service with x402 middleware; gets paid per-request in USDC |
| **Nevermined Plans** | Nevermined | Agent registers pricing plans (free/monthly/yearly/custom); buyers purchase access |
| **Skyfire No-Code** | Skyfire | Service providers monetize by accepting payments from paying agents |
| **ACP Merchant** | Stripe/OpenAI | Agent-as-merchant exposes products via ACP; gets discovered in ChatGPT etc. |
| **Agentic Wallet** | Coinbase | Agent wallet can receive, hold, trade, and earn yield on crypto |
| **Crossmint World Store** | Crossmint | Agent sells services; payments via major tokens on 40+ chains |

### Pricing Models for Agent Services (2026)
1. **Usage-based:** Per-token, per-API-call, per-GPU-cycle
2. **Outcome-based:** Charge for results (e.g., per qualified lead, per completed task)
3. **Flex Credits:** Prepaid consumption units redeemed against usage
4. **Dynamic:** Auto-adjust based on volume, customer segments, market conditions
5. **Hybrid:** Platform fee + included credits + overage charges

### Revenue Potential
- Custom AI agent development: $30K-$150K per project, 60-70% margins
- AI agent consulting: $50K-$100K annually within 12-18 months
- No-code agent building: $5K-$50K+ with tools like n8n, Zapier, Make

---

## 8. KYC & Compliance

### The Core Problem
AI agents cannot open bank accounts, get credit cards, or complete traditional KYC. Three approaches have emerged:

### Approach 1: "Know Your Agent" (KYA) - NEW PARADIGM
- **What:** Verifying the identity, origin, and integrity of non-human actors
- **Key Components:**
  - Agent Identity = what/who the agent is (machine identity + human identity behind it)
  - Agent Authentication = verifying identity (cryptographic credentials)
  - Agent Authorization = determining allowed actions (scoped permissions)
  - Digital Agent Passport (DAP) = cryptographically signed token with agent info, developer info, capabilities
- **Providers:**
  - **Skyfire KYAPay:** JWT-based agent identity linked to verified human/org
  - **Sumsub:** KYA software for agentic fraud prevention
  - **Incode:** Verifies identity of autonomous AI systems, detects deepfakes
  - **Microblink:** KYA solutions for agent verification
- **How it works:** The human/org completes KYC once. The agent operates under their verified identity with scoped permissions and spending limits.

### Approach 2: Delegated Compliance (Agent Platform Handles It)
- **Crossmint:** Handles PCI compliance, sales tax, merchant-of-record on behalf of agent developers
- **Stripe:** KYC/KYB built into Connect onboarding; developers never touch raw card data
- **Nevermined:** Smart contracts enforce spending limits at protocol level; session keys have scoped permissions
- **Coinbase:** Private keys in secure enclaves; programmable spending caps

### Approach 3: Crypto-Native (Minimal KYC)
- **x402 Protocol:** No account, no KYC needed - just a wallet with USDC
- **Limitation:** Only for crypto-to-crypto transactions; off-ramping to fiat still requires KYC
- **Agent Wallet Setup:** `npx awal` - no KYC required for the wallet itself
- **Regulatory Risk:** Regulators haven't addressed autonomous agents holding money yet

### Compliance Landscape
- Traditional KYC providers (Jumio, Onfido, Socure) handle human identity verification
- Card networks (Visa, Mastercard) are building agent-specific verification (Trusted Agent Protocol, Agent Pay)
- AP2 uses cryptographic mandates for verifiable, auditable agent authorization
- EU and US regulatory frameworks are evolving but haven't specifically addressed AI agent finances

---

## 9. Crypto-Funded Virtual Cards

### Providers That Bridge Crypto to Card Payments

| Provider | Card Network | Funding | Regions | Fee | Key Feature |
|----------|-------------|---------|---------|-----|-------------|
| **Bitrefill Card** | Visa | BTC (onchain+Lightning), ETH, USDC, BNB | EU/EEA | 1.99% conversion | Prepaid, instant top-up |
| **Immersve** | Mastercard | Crypto from web3 wallets | UK, EU, AU/NZ (expanding) | Varies | Direct from DeFi wallet, no 3rd-party custody |
| **Reap** | Visa | USDC collateral | Global (HK-based) | See pricing page | Corporate card, post-paid model, BIN sponsorship API |
| **Buvei** | Visa/Mastercard | USDT | Global | Contact | API issuing for crypto businesses |

### Reap Card Issuing API (Most Relevant for Agents)
- **What:** White-label card issuing solution for Web2 and Web3 businesses
- **How:** Reap handles everything - card production, issuing, BIN sponsorship, distribution
- **Funding:** Cards collateralized with fiat or USDC (managed by third-party custodian)
- **Model:** Post-paid (like a credit card), not prepaid
- **Settlement:** Pay bills with fiat or digital assets at end of billing cycle
- **Award:** Best Corporate Card - Digital Fiat and Currencies (2025)
- **Circle Partnership:** Uses USDC for borderless finance
- **Website:** https://reap.global
- **Card Issuing API:** https://reap.global/card-issuing

### Immersve (Most Innovative)
- **What:** Principal Mastercard member with smart-contract-based card issuing
- **Innovation:** Users remain in control of their crypto - no third-party custody requirement
- **How:** Smart contracts bridge web3 wallets to Mastercard payments; real-time crypto-to-fiat conversion
- **Partnership:** Bitget Wallet + Mastercard (zero-fee crypto card, July 2025)
- **Scale:** 150M+ merchant acceptance globally
- **Website:** https://immersve.com

---

## 10. Quick Reference: All Products & Links

### Payment Protocols
| Product | By | Link |
|---------|-----|------|
| ACP (Agentic Commerce Protocol) | Stripe + OpenAI | https://agenticcommerce.dev |
| AP2 (Agent Payments Protocol) | Google Cloud | https://ap2-protocol.org |
| x402 | Coinbase | https://github.com/coinbase/x402 |
| KYAPay | Skyfire | https://github.com/skyfire-xyz/kyapay |

### Agent Wallet & Payment SDKs
| Product | By | Install | Link |
|---------|-----|---------|------|
| AgentKit | Coinbase | `npm create onchain-agent@latest` | https://github.com/coinbase/agentkit |
| Agentic Wallets | Coinbase | `npx awal` | https://www.coinbase.com/developer-platform/products/agentkit |
| Stripe Agent Toolkit | Stripe | `npm install @stripe/agent-toolkit` | https://docs.stripe.com/agents |
| PayPal Agent Toolkit | PayPal | `pip install paypal-agent-toolkit` | https://github.com/paypal/agent-toolkit |
| Crossmint GOAT SDK | Crossmint | See docs | https://github.com/Crossmint/crossmint-agentic-finance |
| x402 SDK | Coinbase | `npm install @x402/core @x402/fetch` | https://github.com/coinbase/x402 |
| Nevermined SDK | Nevermined | See docs | https://docs.nevermined.app |
| Payments MCP | Coinbase | Beta | https://docs.cdp.coinbase.com |

### Card Network Agent Frameworks
| Product | By | Link |
|---------|-----|------|
| Trusted Agent Protocol | Visa + Cloudflare | https://developer.visa.com/capabilities/trusted-agent-protocol |
| Agent Pay Acceptance | Mastercard + Cloudflare | https://www.mastercard.com/global/en/news-and-trends/stories/2025/agentic-commerce-framework.html |

### Virtual Card APIs
| Product | By | Link |
|---------|-----|------|
| Stripe Issuing | Stripe | https://docs.stripe.com/issuing |
| Marqeta | Marqeta | https://www.marqeta.com/developer-overview |
| Lithic | Lithic | https://www.lithic.com |
| Reap Card Issuing | Reap | https://reap.global/card-issuing |
| Buvei | Buvei | https://buvei.com |
| Immersve | Immersve | https://immersve.com |

### Crypto-to-Fiat Gateways
| Product | Fee | Link |
|---------|-----|------|
| NOWPayments | 0.5-1% | https://nowpayments.io |
| CoinGate | ~1% | https://coingate.com |
| BitPay | 1% | https://bitpay.com |
| CoinRemitter | 0.23% | https://coinremitter.com |
| Transak | Varies | https://transak.com |
| Onramper | Varies | https://onramper.com |

### Agent Identity/KYA
| Product | By | Link |
|---------|-----|------|
| KYA Identity | Skyfire | https://skyfire.xyz/product |
| KYA Software | Sumsub | https://sumsub.com/blog/know-your-agent |
| Agent Verification | Incode | https://www.incode.com |
| Nevermined ID | Nevermined | https://nevermined.ai |

---

## Market Data

- Global AI agents market: $7.63B (2025) -> projected $182.97B by 2033 (49.6% CAGR)
- Agentic commerce market: $3T-$5T revenue by 2030 (McKinsey)
- AI agent crypto projects: 550+ listed on CoinGecko, $4.34B combined market cap
- Stablecoin transaction volume: $450B/month (2024) -> $710B/month (March 2025)
- AI-driven e-commerce visits: 4,700% YoY increase (Adobe, July 2025)
- 47% of US shoppers use AI for at least one shopping task (Visa research)
- 81% of US consumers expect to use agentic AI tools to shop
- AI agent startup funding: $3.8B+ raised globally in 2024
- Stripe valuation: $140B (Feb 2026 tender offer)

---

## Recommended Architecture for an Autonomous Agent

### Layer 1: Crypto Foundation
- **Coinbase Agentic Wallet** for holding USDC (setup: `npx awal`)
- Fund via crypto or fiat on-ramp (Transak, Onramper, Coinbase)

### Layer 2: Payment Protocols
- **x402** for paying for APIs and services (micropayments, no KYC)
- **x402 paywall middleware** for receiving payments for services provided

### Layer 3: Fiat Bridge (when needed)
- **Stripe x402** integration for receiving fiat from agent's USDC payments
- **Reap** or **Immersve** for crypto-funded virtual cards when card payments required
- **NOWPayments** or **CoinGate** for broader crypto-to-fiat conversion

### Layer 4: Commerce
- **Crossmint World Store** for purchasing 1B+ real-world goods via API
- **Stripe ACP** for selling through ChatGPT and other AI surfaces
- **Skyfire Agent Checkout** for full autonomous purchasing (with Visa credential)

### Layer 5: Identity & Compliance
- **Skyfire KYAPay** for agent identity (JWT-based, linked to verified human/org)
- **Visa Trusted Agent Protocol** / **Mastercard Agent Pay** for merchant trust
- **Spending caps and session limits** via Agentic Wallet guardrails

### Layer 6: Billing & Monetization
- **Nevermined** for usage-based billing with 200ms settlement
- **Stripe** for subscription/outcome-based billing
- **PayPal Agent Toolkit** for fiat commerce integration
