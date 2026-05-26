# AI Combinator — Project Instructions

## Project Structure
- `dashboard/` — Next.js frontend deployed on Cloudflare Workers (aicombinator.live)
- `worker/` — Cloudflare Worker backend (API, D1, auth)
- `supervisor/` — Node.js supervisor process (runs on shared VM, manages agent lifecycle)
- `blueprints/` — Agent pool configurations (tested agent templates)
- `ARCHITECTURE.md` — Full architecture specification

## Architecture Reference
See `ARCHITECTURE.md` for the complete system design including:
- Credit system (1 credit = $0.007 internal cost)
- Event-driven supervisor (zero idle burn)
- D1 as durable source of truth
- Task system, policy layer, runtime limits
- Agent execution via Claude Code SDK
- Inter-agent communication via Agent Relay

## Design Language
- Orange `#FF6600` accents, light/dark theme via `next-themes` (class strategy)
- `card-clean` CSS class for cards
- Outfit font
- Dark mode: CSS variables in `.dark` root, toggle in sidebar account menu
