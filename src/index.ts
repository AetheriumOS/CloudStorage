/**
 * Cloudflare Worker: Pay-as-you-go pre-paid storage billing (GB-hour) for R2
 * 
 * Fiyatlandırma:
 * - Maliyet (R2): 0.015 $ / GB / ay (saatlik bazda hesaplanır)
 * - Satış: 0.030 $ / GB / ay (saatlik bazda hesaplanır)  -> kâr dahil
 * 
 * Hesaplama formülü (GB·saat):
 * - hours_passed = (now - last_updated_timestamp) / 3600
 * - gb = current_storage_bytes / 1024^3
 * - cost_usd = gb * hours_passed * (SALES_RATE_USD_PER_GB_MONTHLY / 730)
 * 
 * AÇIKLAMA:
 * Tipik bulut depolama "GB-month" hesabı yapar. Biz burada "GB-hour" bazlı birikimle
 * zarar etmemek için PRE-PAID (ön ödemeli) bakiyeyi düşüyoruz.
 * 730 = ortalama ay saati (365*24/12). Aylık oranı saatlik'e çevirirken bu yaklaşım kullanılır.
 * 
 * İş akışı (upload/delete):
 * 1. Kullanıcıyı D1'den çek (user_id)
 * 2. Geçen süreyi hesapla, o zamana kadar duran verinin maliyetini balance'den düş
 * 3. balance <= 0 -> is_frozen = 1 ve 402/403 dön
 * 4. R2'ye yaz/sil
 * 5. current_storage_bytes, balance, last_updated_timestamp, updated_at güncelle
 */

import { Hono } from 'hono';

type Bindings = {
  DB: D1Database;
  MY_R2_BUCKET: R2Bucket;
  SALES_RATE_USD_PER_GB_MONTHLY: string;
  COST_RATE_USD_PER_GB_MONTHLY: string;
  MIN_TOPUP_USD: string;
};

type UserRow = {
  user_id: string;
  balance: number;
  current_storage_bytes: number;
  last_updated_timestamp: number;
  is_frozen: number;
};

const GB = 1024 * 1024 * 1024;
const HOURS_PER_MONTH = 730; // 365*24/12

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

const app = new Hono<{ Bindings: Bindings }>();

/**
 * Kullanıcı bakiyesini ve depolamayı güncelleyen yardımcı fonksiyon
 * @param userId - Kullanıcı kimliği
 * @param newStorageBytes - Yeni toplam depolama (byte)
 * @param actionType - 'upload'|'delete'|'set'|'init'
 * @param deltaBytes - Artış/azalış byte
 */
async function updateStorageAndBill(
  c: any,
  userId: string,
  newStorageBytes: bigint | number,
  actionType: 'upload' | 'delete' | 'set' | 'init',
  deltaBytes: bigint | number
): Promise<{
  ok: boolean;
  message?: string;
  newBalance?: number;
  newStorage?: number;
}> {
  const db = c.env.DB;
  const salesMonthly = parseFloat(c.env.SALES_RATE_USD_PER_GB_MONTHLY || '0.030');

  const nsb = typeof newStorageBytes === 'bigint' ? Number(newStorageBytes) : newStorageBytes;
  const dbytes = typeof deltaBytes === 'bigint' ? Number(deltaBytes) : deltaBytes;

  // 1) Kullanıcıyı kilitleyerek çek
  const userRes = await db
    .prepare('SELECT user_id, balance, current_storage_bytes, last_updated_timestamp, is_frozen FROM users WHERE user_id = ?')
    .bind(userId)
    .first<UserRow>();

  let user: UserRow;
  if (!userRes) {
    // İlk kez: kullanıcı yoksa oluştur
    await db
      .prepare(
        `INSERT INTO users (user_id, balance, current_storage_bytes, last_updated_timestamp, is_frozen, created_at, updated_at)
         VALUES (?, 0.0, 0, ?, 1, ?, ?)`
      )
      .bind(userId, nowSec(), nowSec(), nowSec())
      .run();
    user = {
      user_id: userId,
      balance: 0.0,
      current_storage_bytes: 0,
      last_updated_timestamp: nowSec(),
      is_frozen: 1,
    };
  } else {
    user = userRes;
  }

  // Zaten dondurulmuşsa engelle
  if (user.is_frozen === 1 && user.balance <= 0) {
    return { ok: false, message: 'Hesap dondurulmuş. Lütfen bakiye yükleyin.' };
  }

  const now = nowSec();
  let balanceAfterAccrual = user.balance;

  // 2) Geçen süre üzerinden birikmiş maliyeti düş
  if (user.last_updated_timestamp > 0 && user.current_storage_bytes > 0) {
    const hoursPassed = Math.max(0, (now - user.last_updated_timestamp) / 3600);
    if (hoursPassed > 0) {
      const gbStored = user.current_storage_bytes / GB;
      if (gbStored > 0) {
        // cost = gb * hours * (salesMonthly / 730)
        const costUsd = gbStored * hoursPassed * (salesMonthly / HOURS_PER_MONTH);
        if (costUsd > 0) {
          balanceAfterAccrual = user.balance - costUsd;
        } else {
          balanceAfterAccrual = user.balance;
        }
      } else {
        balanceAfterAccrual = user.balance;
      }
    } else {
      balanceAfterAccrual = user.balance;
    }
  } else {
    balanceAfterAccrual = user.balance;
  }

  // 3) Bakiye kontrolü
  if (balanceAfterAccrual <= 0) {
    await db
      .prepare('UPDATE users SET is_frozen = 1, updated_at = ? WHERE user_id = ?')
      .bind(nowSec(), userId)
      .run();
    return {
      ok: false,
      message: 'Yetersiz bakiye. Hesap donduruldu. Yeni dosya yüklenemez.',
      newBalance: Number(balanceAfterAccrual.toFixed(6)),
    };
  }

  // 4) R2 işlemi upload/delete/set için çağrıyı üst katmanda yapmalısın
  // Burada sadece DB güncellemesi yaparız (R2 tarafı route içinde yapılacak)

  // 5) Durumu güncelle
  await db
    .prepare(
      `UPDATE users SET
         balance = ?,
         current_storage_bytes = ?,
         last_updated_timestamp = ?,
         is_frozen = 0,
         updated_at = ?
       WHERE user_id = ?`
    )
    .bind(
      Number(balanceAfterAccrual.toFixed(6)),
      nsb,
      now,
      nowSec(),
      userId
    )
    .run();

  // Audit
  await db
    .prepare(
      `INSERT INTO storage_billing_events
       (user_id, action_type, delta_bytes, storage_bytes_before, storage_bytes_after,
        hours_passed, cost_usd, rate_usd_per_gb_monthly, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      userId,
      actionType,
      dbytes,
      user.current_storage_bytes,
      nsb,
      Number(((user.last_updated_timestamp > 0 && user.current_storage_bytes > 0) ? Math.max(0, (now - user.last_updated_timestamp) / 3600) : 0).toFixed(6)),
      Number((balanceAfterAccrual - user.balance >= 0 ? 0 : (user.balance - balanceAfterAccrual)).toFixed(6)),
      salesMonthly,
      now
    )
    .run();

  return {
    ok: true,
    newBalance: Number(balanceAfterAccrual.toFixed(6)),
    newStorage: nsb,
  };
}

// Basit sağlık
app.get('/health', (c) => c.json({ ok: true }));

// Bakiye ekle (minimum 5.00) - örnek
app.post('/topup', async (c) => {
  const body = await c.req.json<{ userId: string; amountUsd: number }>().catch(() => ({} as any));
  const userId = body.userId;
  const amountUsd = Number(body.amountUsd);
  if (!userId || isNaN(amountUsd) || amountUsd < parseFloat(c.env.MIN_TOPUP_USD || '5.00')) {
    return c.json({ ok: false, message: `Minimum yükleme: $${c.env.MIN_TOPUP_USD}` }, 400);
  }
  const db = c.env.DB;
  const u = await db.prepare('SELECT balance, is_frozen FROM users WHERE user_id = ?').bind(userId).first<any>();
  if (!u) {
    await db
      .prepare(
        `INSERT INTO users (user_id, balance, current_storage_bytes, last_updated_timestamp, is_frozen, created_at, updated_at)
         VALUES (?, ?, 0, ?, 0, ?, ?)`
      )
      .bind(userId, amountUsd, nowSec(), nowSec(), nowSec())
      .run();
    return c.json({ ok: true, newBalance: amountUsd });
  }
  const newBal = (u.balance + amountUsd);
  await db.prepare('UPDATE users SET balance = ?, is_frozen = 0, updated_at = ? WHERE user_id = ?').bind(newBal, nowSec(), userId).run();
  return c.json({ ok: true, newBalance: Number(newBal.toFixed(6)) });
});

// UPLOAD: önce faturalandır, sonra R2'ye yaz
app.post('/upload', async (c) => {
  const form = await c.req.formData();
  const file = form.get('file') as File | null;
  const userId = form.get('userId') as string | null;
  const key = form.get('key') as string | null; // R2 key (path)

  if (!file || !userId || !key) {
    return c.json({ ok: false, message: 'file, userId, key gerekli' }, 400);
  }

  const db = c.env.DB;
  const uBefore = await db.prepare('SELECT current_storage_bytes FROM users WHERE user_id = ?').bind(userId).first<any>();
  const totalBefore = uBefore?.current_storage_bytes || 0;
  const totalAfter = totalBefore + file.size;

  // Faturalandır + bakiye kontrolü
  const billed = await updateStorageAndBill(c, userId, totalAfter, 'upload', file.size);
  if (!billed.ok) {
    return c.json({ ok: false, message: billed.message }, 402);
  }

  // R2'ye yaz
  await c.env.MY_R2_BUCKET.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || 'application/octet-stream' },
  });

  return c.json({ ok: true, key, size: file.size, newBalance: billed.newBalance, newStorage: billed.newStorage });
});

// DELETE: önce faturalandır (mevcut verinin süresini hesaba kat), sonra R2'den sil
app.post('/delete', async (c) => {
  const body = await c.req.json<{ userId: string; key: string }>().catch(() => ({} as any));
  const userId = body.userId;
  const key = body.key;
  if (!userId || !key) return c.json({ ok: false, message: 'userId, key gerekli' }, 400);

  const db = c.env.DB;
  const meta = await c.env.MY_R2_BUCKET.head(key);
  const objSize = meta?.size || 0;

  const uBefore = await db.prepare('SELECT current_storage_bytes FROM users WHERE user_id = ?').bind(userId).first<any>();
  const totalBefore = uBefore?.current_storage_bytes || 0;
  const totalAfter = Math.max(0, totalBefore - objSize);

  // Silmeden önce birikimi düş (kural 2)
  const billed = await updateStorageAndBill(c, userId, totalAfter, 'delete', -objSize);
  if (!billed.ok) {
    // Bakiye 0'a inmişse yine dondurulur; ama silme genelde serbest yapılabilir istersen ayrı tut
  }

  await c.env.MY_R2_BUCKET.delete(key);
  return c.json({ ok: true, deleted: key, newBalance: billed.newBalance, newStorage: billed.newStorage });
});

app.get('/status/:userId', async (c) => {
  const userId = c.req.param('userId');
  const db = c.env.DB;
  const u = await db.prepare('SELECT * FROM users WHERE user_id = ?').bind(userId).first();
  if (!u) return c.json({ ok: false }, 404);
  return c.json({ ok: true, user: u });
});

export default app;
