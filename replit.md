# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Artifacts

### API Server (`artifacts/api-server`)
- Express 5 REST API on port 8080
- Routes: `/api/healthz`, `/api/voice/chat`
- Voice endpoint: POST `/api/voice/chat` — accepts base64 audio, returns AI response audio (MP3) + both user and assistant transcripts
- Uses `@workspace/integrations-openai-ai-server` for:
  - `speechToText` (gpt-4o-mini-transcribe) → user transcript
  - `voiceChat` (gpt-audio) → assistant audio + assistant transcript
  - Both run in parallel for efficiency

### Mobile App (`artifacts/mobile`)
- Expo React Native (SDK 54) on port 18115
- Single-screen voice assistant (no tabs)
- Dark minimalist design: deep navy (#0a0f1e) + electric indigo (#4f6ef7)
- Screens: `app/index.tsx` (main voice screen), `app/settings.tsx` (voice settings)
- Key features:
  - Voice recording via expo-av
  - Audio playback via expo-av + expo-file-system
  - Chat history via AsyncStorage
  - Animated voice orb (idle/recording/processing/speaking states)
  - Bluetooth headphone controls via react-native-track-player (native build only)
  - Background service via react-native-background-actions (native build only)
  - Rolling audio buffer: continuous 30s segment recording keeping last 10 min on disk (`services/rollingBufferManager.ts`)
  - Rolling buffer auto-pauses during manual voice recording to avoid mic conflicts
  - Toggle in Settings screen ("Grabación continua") persisted via AsyncStorage
  - EAS development build configured via `eas.json`
- Context: `context/AssistantContext.tsx` — all state + voice flow logic + rolling buffer access

## Notes

- Native Bluetooth controls (react-native-track-player) and background service (react-native-background-actions) require an EAS native build. Core AI voice works in Expo Go.
- expo-av is deprecated in SDK 54 (use expo-audio/expo-video in future). Currently functional.
- OpenAI integration uses Replit AI Integrations proxy — no user API key needed.
- **RNTP Kotlin patch**: `react-native-track-player@4.1.2` has a Kotlin nullability bug with RN 0.81 — `originalItem` is `Bundle?` but `Arguments.fromBundle()` requires non-nullable `Bundle`. Fixed via pnpm native patch (`patches/react-native-track-player@4.1.2.patch`) adding `!!` at MusicModule.kt lines 548 and 588. Referenced in root `package.json` under `pnpm.patchedDependencies`. pnpm auto-applies during install including EAS builds.
