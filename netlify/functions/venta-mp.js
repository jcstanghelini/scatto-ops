// netlify/functions/venta-mp.js — v2
// Webhook de Mercado Pago con dos avisos:
//   🛒 venta nueva (pago aprobado recién)
//   💸 plata liberada (el pago pasó a "released" recién)
// Usa las mismas variables de entorno (MP_TOKEN, TG_TOKEN, TG_CHAT_ID).

// --- helpers ---------------------------------------------------------------

function fechaART(date) {
  const art = new Date(date.getTime() - 3 * 60 * 60 * 1000);
  return art.toISOString().slice(0, 10);
}

function fechaLinda(yyyymmdd) {
  const [y, m, d] = yyyymmdd.split("-");
  return `${d}/${m}`;
}

function plata(n) {
  return "$" + Math.round(n).toLocaleString("es-AR");
}

async function miUserId() {
  const res = await fetch("https://api.mercadopago.com/users/me", {
    headers: { Authorization: `Bearer ${process.env.MP_TOKEN}` },
  });
  if (!res.ok) throw new Error(`MP /users/me: ${res.status}`);
  return (await res.json()).id;
}

async function traerPago(id) {
  const res = await fetch(`https://api.mercadopago.com/v1/payments/${id}`, {
    headers: { Authorization: `Bearer ${process.env.MP_TOKEN}` },
  });
  if (!res.ok) throw new Error(`MP /payments/${id}: ${res.status}`);
  return res.json();
}

async function enviarTelegram(texto) {
  await fetch(`https://api.telegram.org/bot${process.env.TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: process.env.TG_CHAT_ID,
      text: texto,
      parse_mode: "Markdown",
    }),
  });
}

function netoDe(p) {
  return (
    (p.transaction_details && p.transaction_details.net_received_amount) ||
    p.transaction_amount ||
    0
  );
}

// --- handler ---------------------------------------------------------------

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");

    const pagoId =
      (body.data && body.data.id) ||
      body["data.id"] ||
      (body.resource && String(body.resource).split("/").pop()) ||
      null;

    const esDePagos =
      (body.type || body.topic || "").toString().includes("payment");

    if (!pagoId || !esDePagos) {
      return { statusCode: 200, body: "ignorado" };
    }

    const [myId, pago] = await Promise.all([miUserId(), traerPago(pagoId)]);

    const collector =
      pago.collector_id || (pago.collector && pago.collector.id) || null;

    const esVentaMia =
      pago.status === "approved" &&
      String(collector) === String(myId) &&
      pago.operation_type !== "account_fund";

    if (!esVentaMia) {
      return { statusCode: 200, body: "no es venta mía" };
    }

    const ahora = Date.now();
    const minutosDesde = (fecha) =>
      fecha ? (ahora - new Date(fecha).getTime()) / 60000 : 9999;

    const aprobadoHaceMin = minutosDesde(pago.date_approved);
    const liberadoHaceMin = minutosDesde(pago.money_release_date);
    const yaLiberado = pago.money_release_status === "released";

    const neto = netoDe(pago);
    const desc = pago.description || "Venta";

    // CASO 1: venta nueva (aprobada hace menos de 10 minutos, todavía no liberada)
    if (!yaLiberado && aprobadoHaceMin < 10) {
      const libera = pago.money_release_date
        ? fechaLinda(fechaART(new Date(pago.money_release_date)))
        : "a confirmar";
      await enviarTelegram(
        `🛒 *Nueva venta SCATTO*\n\n` +
          `*${plata(neto)}* neto (bruto ${plata(pago.transaction_amount || 0)})\n` +
          `${desc}\n` +
          `💸 Se libera el ${libera}`
      );
      return { statusCode: 200, body: "aviso de venta enviado" };
    }

    // CASO 2: liberación (pasó a "released" y la fecha de liberación es de
    // las últimas 3 horas — ventana para cubrir demoras del evento de MP)
    if (yaLiberado && liberadoHaceMin >= 0 && liberadoHaceMin < 180) {
      await enviarTelegram(
        `💸 *Plata liberada — SCATTO*\n\n` +
          `*${plata(neto)}* ya disponibles en MP\n` +
          `${desc}`
      );
      return { statusCode: 200, body: "aviso de liberación enviado" };
    }

    return { statusCode: 200, body: "evento sin aviso" };
  } catch (err) {
    console.error("Error webhook venta-mp:", err.message);
    return { statusCode: 200, body: "error: " + err.message };
  }
};
