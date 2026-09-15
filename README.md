# SCATTO — Sitio web y sistema operativo interno

Sitio público de [scatto.com.ar](https://scatto.com.ar) (marca argentina de soportes magnéticos MagSafe para auto) junto con las herramientas internas que operan el negocio: escáner de pedidos, impresión de etiquetas QR, panel financiero y alertas automáticas por Telegram.

Todo corre en **Netlify** (sitio estático + funciones serverless), sin servidores propios ni dependencias de npm: cada función es un archivo Node.js autocontenido que usa `fetch` contra las APIs de Tiendanube, Mercado Pago y MercadoLibre.

## Arquitectura

```
Pagina/
├── index.html · nosotros.html          Sitio público
├── scan.html                           Escáner de pedidos (PWA, uso interno)
├── etiquetas.html                      Impresión de etiquetas QR (60×62 mm)
├── finanzas.html                       Panel financiero (PWA, uso interno)
├── manifest.json · manifest-finanzas.json
├── netlify.toml                        Directorio de funciones + cron de alertas
└── netlify/functions/
    ├── scan.js          Puente con Tiendanube: buscar orden, marcar empaquetado / enviado /
    │                    entregado, cargar tracking, generar mensaje de WhatsApp al cliente
    ├── finanzas.js      Consolida ventas de todos los canales y calcula margen real
    ├── liberaciones.js  Cron: resumen diario y avisos de dinero liberado por Mercado Pago
    ├── venta-mp.js      Webhook de Mercado Pago: aviso instantáneo por cada venta
    └── ml-auth.js       OAuth con MercadoLibre (tokens persistidos en Supabase)
```

### Flujo de datos

```
Tiendanube API ──┐
                 ├──► finanzas.js ──► finanzas.html (panel) / CSV para facturación
Mercado Pago API ┤
                 └──► liberaciones.js ──► Telegram (8:30 resumen · 12:30/15:30/23:30 liberaciones)
MercadoLibre API ──► finanzas.js (datos fiscales del comprador, unidades, estado del envío)
Mercado Pago webhook ──► venta-mp.js ──► Telegram (🛒 venta nueva)
Supabase ──► tokens de ML · memoria de avisos enviados
```

### Decisiones de diseño que importan

- **Tiendanube es la fuente de verdad del canal Tienda** (incluye Pago Nube, MODO y ventas manuales, que no pasan por Mercado Pago). Mercado Pago aporta netos reales y fechas de liberación.
- **Las ventas de ML con pagos combinados** (dos pagos de MP para una orden) se agrupan por `order.id` antes de contar unidades o descontar costos.
- **Los movimientos internos** (transferencias propias, particiones, fondeos) se excluyen filtrando `collector_id`/`payer.id` contra el usuario de MP.
- **El neto de Pago Nube / Payway no está en ninguna API**: se estima con la comisión de cada pasarela (calibrada con liquidaciones reales, por cantidad de cuotas y fecha del cambio de plan) y se puede cargar el exacto desde el panel; el valor se persiste en las notas internas de la orden de Tiendanube.
- **Sin estado en Netlify**: lo que necesita persistir (tokens de ML, lo ya avisado por Telegram) vive en Supabase; la corrida diaria de las 8:30 la mantiene activa.
- **Los números del negocio** (costo unitario importado, reserva por unidad, fijos mensuales, comisiones) están al inicio de `finanzas.js` como constantes documentadas.

## Panel financiero

Por mes calendario: ventas por canal y vía de cobro, neto y margen por venta (descontando costo del producto, comisiones y envío), potes (reposición / operación / crecimiento), estado del envío en vivo, y detalle desplegable con los datos de facturación del comprador. Exporta CSV (separador `;`) con documento, domicilio y condición de IVA para la facturación electrónica.

## Variables de entorno (Netlify)

Ver [`.env.example`](.env.example). Ningún secreto vive en el código.

## Deploy

Deploy manual arrastrando la carpeta `Pagina` a Netlify, o conectando este repositorio. `netlify.toml` declara el directorio de funciones y el cron de `liberaciones` (horarios en UTC, hora Argentina = UTC−3).

## Autor

Juan Carlos Stanghelini — [github.com/jcstanghelini](https://github.com/jcstanghelini)
