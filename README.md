# R2 Browser

A lightweight Cloudflare R2 storage browser built as a Workers application. Browse images, view thumbnails, multi-select for batch download/delete, and filter by date.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Edit `wrangler.toml` and set your R2 bucket name:
   ```toml
   [[r2_buckets]]
   binding = "BUCKET"
   bucket_name = "your-actual-bucket-name"
   ```

3. Deploy to Cloudflare Workers:
   ```bash
   npm run deploy
   ```

4. Run locally for development:
   ```bash
   npm run dev
   ```

## Features

- Grid view with image thumbnails
- Click to open full-size lightbox with keyboard navigation
- Multi-select with checkboxes (Ctrl+A to select all)
- Download single files or batch download as ZIP
- Batch delete with confirmation
- Date range filter
- File type filter (images only or all files)
- Prefix search
- Load more pagination

## Notes

- The R2 bucket must be in the same Cloudflare account as the Worker
- No authentication is required by default — anyone with the URL can browse your bucket
