// netlify/functions/liberaciones.js — v5
// Corre 4 veces por día (ver netlify.toml):
//   8:30  → resumen del día (qué se libera hoy + pendiente)
//   12:30, 15:30 y 23:30 → avisa SOLO lo liberado nuevo desde el último aviso
//   (recuerda en Supabase cuánto avisó cada día, tabla "avisos_liberacion")
// Agrupa pagos combinados de ML por orden para contar ventas reales.

const DIAS_HACIA_ATRAS = 45;

// --- helpers ---------------------------------------------------------------

function fechaART(date) {
  const art = new Date(date.getTime() - 3 * 60 * 60 * 1000);
  return art.toISOString().slice(0, 10);
}

function horaART() {
  return (new Date().getUTCHours() - 3 + 24) % 24;
}

function plata(n) {
  return "$" + Math.round(n).toLocaleString("es-AR");
}

function fechaLinda(yyyymmdd) {
  const [y, m, d] = yyyymmdd.split("-");
  return `${d}/${m}`;
}

// --- Mercado Pago ----------------------------------------------------------

async function miUserId() {
  const res = await fetch("https://api.mercadopago.com/users/me", {
    headers: { Authorization: `Bearer ${process.env.MP_TOKEN}` },
  });
  if (!res.ok) throw new Error(`MP /users/me respondió ${res.status}`);
  return (await res.json()).id;
}

async function buscarPagos() {
  const desde = new Date(Date.now() - DIAS_HACIA_ATRAS * 24 * 60 * 60 * 1000);
  const pagos = [];
  let offset = 0;
  while (true) {
    const url =
      "https://api.mercadopago.com/v1/payments/search" +
      "?sort=date_approved&criteria=desc&range=date_approved" +
      `&begin_date=${desde.toISOString()}` +
      `&end_date=${new Date().toISOString()}` +
      `&limit=50&offset=${offset}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.MP_TOKEN}` },
    });
    if (!res.ok) throw new Error(`MP respondió ${res.status}: ${await res.text()}`);
    const data = await res.json();
    pagos.push(...(data.results || []));
    offset += 50;
    if (!data.paging || offset >= data.paging.total || pagos.length >= 500) break;
  }
  return pagos;
}

function collectorDe(p) {
  return p.collector_id || (p.collector && p.collector.id) || null;
}

function payerIdDe(p) {
  return (p.payer && p.payer.id) || null;
}

function netoDe(p) {
  const neto =
    (p.transaction_details && p.transaction_details.net_received_amount) ||
    p.transaction_amount || 0;
  const devuelto = p.transaction_amount_refunded || 0;
  if (devuelto > 0 && p.transaction_amount > 0) {
    return Math.max(0, neto - devuelto * (neto / p.transaction_amount));
  }
  return neto;
}

function esVentaMia(p, myId) {
  return (
    p.status === "approved" &&
    !!p.money_release_date &&
    String(collectorDe(p)) === String(myId) &&
    String(payerIdDe(p)) !== String(myId) &&
    p.operation_type !== "account_fund" &&
    p.operation_type !== "money_transfer" &&
    p.operation_type !== "partition_transfer"
  );
}

// --- Supabase: memoria de lo ya avisado (y keep-alive) ----------------------

function sbHeaders(extra) {
  return Object.assign(
    { apikey: process.env.SUPABASE_KEY, Authorization: `Bearer ${process.env.SUPABASE_KEY}` },
    extra || {}
  );
}

async function avisadoHoy(fecha) {
  if (!process.env.SUPABASE_URL) return 0;
  try {
    const res = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/avisos_liberacion?fecha=eq.${fecha}&select=liberado`,
      { headers: sbHeaders() }
    );
    if (!res.ok) return 0;
    const filas = await res.json();
    return filas && filas[0] ? Number(filas[0].liberado) || 0 : 0;
  } catch (_) { return 0; }
}

async function guardarAvisado(fecha, liberado) {
  if (!process.env.SUPABASE_URL) return;
  try {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/avisos_liberacion`, {
      method: "POST",
      headers: sbHeaders({ "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" }),
      body: JSON.stringify({ fecha, liberado, actualizado: new Date().toISOString() }),
    });
  } catch (_) {}
}


async function tocarSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) return;
  try {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/ml_tokens?select=id&limit=1`, {
      headers: {
        apikey: process.env.SUPABASE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_KEY}`,
      },
    });
  } catch (_) {}
}

// --- Telegram --------------------------------------------------------------

async function enviarTelegram(texto) {
  const res = await fetch(
    `https://api.telegram.org/bot${process.env.TG_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: process.env.TG_CHAT_ID,
        text: texto,
        parse_mode: "Markdown",
      }),
    }
  );
  if (!res.ok) throw new Error(`Telegram respondió ${res.status}: ${await res.text()}`);
}

// --- handler ---------------------------------------------------------------

exports.handler = async (event) => {
  const esProgramada = !!(event.body && event.body.includes("next_run"));
  const qs = event.queryStringParameters || {};
  if (!esProgramada && qs.key !== process.env.ALERT_KEY) {
    return { statusCode: 401, body: "No autorizado" };
  }

  try {
    await tocarSupabase();

    const [myId, pagos] = await Promise.all([miUserId(), buscarPagos()]);
    const hoy = fechaART(new Date());
    const ventas = pagos.filter((p) => esVentaMia(p, myId));

    // Agrupar por fecha de liberación, contando ventas (no pagos: ML puede
    // partir una venta en dos pagos combinados que comparten order.id)
    const porFecha = {};
    for (const p of ventas) {
      const f = fechaART(new Date(p.money_release_date));
      if (!porFecha[f]) porFecha[f] = { total: 0, liberado: 0, ordenes: new Set(), ordenesLib: new Set() };
      const clave = (p.order && p.order.id) ? "o" + p.order.id : "p" + p.id;
      porFecha[f].total += netoDe(p);
      porFecha[f].ordenes.add(clave);
      if (p.money_release_status === "released") {
        porFecha[f].liberado += netoDe(p);
        porFecha[f].ordenesLib.add(clave);
      }
    }
    for (const f of Object.keys(porFecha)) {
      porFecha[f].ventas = porFecha[f].ordenes.size;
      porFecha[f].liberadas = porFecha[f].ordenesLib.size;
    }

    const deHoy = porFecha[hoy];
    const hora = qs.modo === "tarde" ? 15 : horaART();

    // ---------- Corridas de la tarde/noche: avisar solo lo nuevo ----------
    if (hora >= 12) {
      const liberadoHoy = deHoy ? Math.round(deHoy.liberado) : 0;
      const yaAvisado = await avisadoHoy(hoy);
      const nuevo = liberadoHoy - yaAvisado;
      if (nuevo > 0) {
        const msg =
          "💸 *SCATTO — Plata liberada*\n\n" +
          `*${plata(nuevo)}* recién liberados en MP` +
          (yaAvisado > 0 ? `\nTotal de hoy: ${plata(liberadoHoy)} (${deHoy.liberadas} venta${deHoy.liberadas > 1 ? "s" : ""})` : ` (${deHoy.liberadas} venta${deHoy.liberadas > 1 ? "s" : ""})`);
        await enviarTelegram(msg);
        await guardarAvisado(hoy, liberadoHoy);
        return { statusCode: 200, body: "Aviso enviado:\n\n" + msg };
      }
      return { statusCode: 200, body: `Sin novedades: liberado hoy ${plata(liberadoHoy)}, ya avisado ${plata(yaAvisado)}.` };
    }

    // ---------- Corrida de la mañana: resumen completo ----------
    const futuras = Object.keys(porFecha).filter((f) => f > hoy).sort();
    let msg = "";

    if (deHoy) {
      msg += `💰 *Hoy se libera ${plata(deHoy.total)}* (${deHoy.ventas} venta${deHoy.ventas > 1 ? "s" : ""})\n`;
    } else {
      msg += "💤 Hoy no se libera dinero.\n";
    }

    if (futuras.length > 0) {
      const totalPendiente = futuras.reduce((acc, f) => acc + porFecha[f].total, 0);
      msg += `\n📅 *Pendiente: ${plata(totalPendiente)}*\n`;
      for (const f of futuras) {
        msg += `  • ${fechaLinda(f)}: ${plata(porFecha[f].total)} (${porFecha[f].ventas})\n`;
      }
    } else if (!deHoy) {
      msg += "\nNo hay liberaciones pendientes.";
    }

    msg = "🔴 *SCATTO — Liberaciones MP*\n\n" + msg;
    await enviarTelegram(msg);
    return { statusCode: 200, body: "Alerta enviada:\n\n" + msg };
  } catch (err) {
    try {
      await enviarTelegram("⚠️ Error en la alerta de liberaciones: " + err.message);
    } catch (_) {}
    return { statusCode: 500, body: "Error: " + err.message };
  }
};
