// netlify/functions/ml-auth.js
// Conecta tu cuenta de MercadoLibre una sola vez. Los tokens se guardan en
// Supabase y se renuevan solos desde finanzas.js.
//
// Variables de entorno necesarias:
//   ML_APP_ID      → App ID de tu aplicación de MercadoLibre
//   ML_SECRET      → Secret Key de esa aplicación
//   SUPABASE_URL   → https://xxxx.supabase.co
//   SUPABASE_KEY   → service_role key del proyecto
//   ALERT_KEY      → tu clave interna (ya la tenés)
//
// Uso:
//   /.netlify/functions/ml-auth?key=TU_CLAVE          → conectar con ML
//   /.netlify/functions/ml-auth?key=TU_CLAVE&estado=1 → ver si está conectado

const REDIRECT_URI = "https://scatto.com.ar/.netlify/functions/ml-auth";

function sbHeaders(extra) {
  return Object.assign(
    {
      apikey: process.env.SUPABASE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_KEY}`,
    },
    extra || {}
  );
}

async function guardarTokens(tokens) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/ml_tokens`, {
    method: "POST",
    headers: sbHeaders({
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    }),
    body: JSON.stringify({
      id: 1,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      user_id: String(tokens.user_id || ""),
      expira: new Date(Date.now() + (tokens.expires_in || 21600) * 1000).toISOString(),
      actualizado: new Date().toISOString(),
    }),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function leerTokens() {
  try {
    const res = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/ml_tokens?id=eq.1&select=*`,
      { headers: sbHeaders() }
    );
    if (!res.ok) return null;
    const filas = await res.json();
    return filas && filas[0] ? filas[0] : null;
  } catch (_) {
    return null;
  }
}

exports.handler = async (event) => {
  const qs = event.queryStringParameters || {};

  // Paso 2: ML nos devuelve el código de autorización
  if (qs.code) {
    try {
      const res = await fetch("https://api.mercadolibre.com/oauth/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: process.env.ML_APP_ID,
          client_secret: process.env.ML_SECRET,
          code: qs.code,
          redirect_uri: REDIRECT_URI,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.access_token) {
        throw new Error(JSON.stringify(data).slice(0, 300));
      }
      await guardarTokens(data);
      return {
        statusCode: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
        body:
          "<h2 style='font-family:sans-serif'>✅ MercadoLibre conectado</h2>" +
          "<p style='font-family:sans-serif'>Ya podés cerrar esta pestaña y volver al panel de finanzas.</p>",
      };
    } catch (err) {
      return { statusCode: 500, body: "Error al conectar: " + err.message };
    }
  }

  // Estado de la conexión
  if (qs.key === process.env.ALERT_KEY && qs.estado === "1") {
    const conf = !!(process.env.SUPABASE_URL && process.env.SUPABASE_KEY);
    const t = conf ? await leerTokens() : null;
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body:
        `Supabase configurado: ${conf ? "SÍ" : "NO"}\n` +
        (t
          ? `Conectado. user_id: ${t.user_id}\nToken vence: ${new Date(t.expira).toLocaleString("es-AR")}\nÚltima actualización: ${t.actualizado}`
          : "Sin conexión guardada. Entrá a esta misma URL sin &estado=1 para conectar."),
    };
  }

  // Paso 1: mandar a autorizar
  if (qs.key === process.env.ALERT_KEY) {
    const url =
      "https://auth.mercadolibre.com.ar/authorization?response_type=code" +
      `&client_id=${process.env.ML_APP_ID}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
    return { statusCode: 302, headers: { Location: url }, body: "" };
  }

  return { statusCode: 401, body: "No autorizado" };
};
