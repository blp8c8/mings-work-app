import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(
      process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || ''
    ),
    'import.meta.env.VITE_SUPABASE_KEY': JSON.stringify(
      process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_KEY || ''
    ),
  }
})
