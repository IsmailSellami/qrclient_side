import { createApp } from '../server/app.js';
import { pool, supabase, authFactory } from '../server/database.js';

// Vercel imports the handler without opening a listening socket.
export default createApp({ pool, supabase, authFactory });
