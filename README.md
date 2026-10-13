# Cloud Storage SaaS (Cloudflare Workers + D1 + R2) — Pay-as-you-go Pre-paid

Pre-paid (ön ödemeli) bakiye sistemi ile GB-saat bazlı faturalandırma.

## 1. D1 Veritabanı Oluştur

```bash
wrangler d1 create cloud_storage_db
```

Çıkan `database_id`'yi `wrangler.jsonc` içindeki `d1_databases[0].database_id` satırına yapıştır.

## 2. Şemayı Uygula (Local)

```bash
wrangler d1 execute cloud_storage_db --local --file=./schema.sql
```

## 3. Şemayı Uygula (Prod)

```bash
wrangler d1 execute cloud_storage_db --file=./schema.sql
```

## 4. R2 Bucket Oluştur

```bash
wrangler r2 bucket create cloud-storage-bucket
```

## 5. Geliştirme/Deploy

```bash
npm i
npm run dev
npm run deploy
```

## Hesaplama Formülü

- Aylık satış: 0.030 $ / GB / ay
- Saatlik katsayı: 730 (365*24/12)

```text
hours_passed = (current_time - last_updated_timestamp) / 3600
gb_stored    = current_storage_bytes / (1024^3)
cost_usd     = gb_stored * hours_passed * (0.030 / 730)
```

Upload/Delete öncesi bu `cost` balance'den düşülür. `balance <= 0` → `is_frozen=1`, yeni yükleme reddedilir (402).

## Endpoint'ler

- `POST /topup` `{ userId, amountUsd }` (min $5.00)
- `POST /upload` `form-data` (`file`, `userId`, `key`)
- `POST /delete` `{ userId, key }`
- `GET /status/:userId`
- `GET /health`

**Not:** Upload/Delete sırası: önce billing (accrual + bakiye kontrol), sonra R2. Bu kural zarar etmemenizi sağlar.
