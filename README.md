This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## EssayWriter Studio + Supabase

Copy `.env.example` to `.env.local` and fill in `NVIDIA_NIM_API_KEY`,
`TAVILY_API_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, and `SUPABASE_SECRET_KEY`
(find the last two under Supabase dashboard → Project Settings → Data API).

Set `OPENROUTER_API_KEY` in `.env.local` to use
`openai/gpt-6-luna` as the text model. This OpenRouter model is billed
per token, and all essay text runs on it — there is no fallback, so every
essay reads in one consistent voice. `NVIDIA_NIM_API_KEY` is only used for
image transcription of uploaded instruction-sheet photos. Keep both keys
on the server, out of Git.

Draft paragraphs and source-audit batches run sequentially. Transient
overloads retry with increasing delays. The NVIDIA fallback is independent
of OpenRouter's Luna providers.

Create the tables once: open Supabase dashboard → SQL Editor → run the
statements in `supabase/schema.sql`. Without them (or without keys) the app
keeps working on an in-memory fallback, but nothing persists across restarts.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
