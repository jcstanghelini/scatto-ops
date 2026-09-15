// SCATTO Envios - Netlify Function
// Puente entre la pagina de escaneo y la API de Tiendanube.
// Requiere variables de entorno en Netlify: TN_TOKEN y SCAN_KEY.

const STORE_ID = "7747275";
const API_BASE = "https://api.tiendanube.com/v1/" + STORE_ID;
const USER_AGENT = "SCATTO Envios (contacto@scatto.com.ar)";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Scan-Key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function json(statusCode, data) {
  return { statusCode, headers: CORS, body: JSON.stringify(data) };
}

async function tn(method, path, body) {
  const res = await fetch(API_BASE + path, {
    method,
    headers: {
      "Authentication": "bearer " + process.env.TN_TOKEN,
      "Authorization": "Bearer " + process.env.TN_TOKEN,
      "User-Agent": USER_AGENT,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

// Normaliza un telefono argentino a formato wa.me (549 + area + numero)
function waPhone(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("0054")) d = d.slice(4);
  else if (d.startsWith("054")) d = d.slice(3);
  if (d.startsWith("54")) {
    d = d.slice(2);
    if (d.startsWith("9")) d = d.slice(1);
  }
  if (d.startsWith("0")) d = d.slice(1);
  // quita el 15 despues del codigo de area (formato viejo)
  if (d.length === 12 && d.slice(2, 4) === "15") d = d.slice(0, 2) + d.slice(4);
  if (d.length === 13 && d.slice(3, 5) === "15") d = d.slice(0, 3) + d.slice(5);
  if (d.length < 10) return null;
  return "549" + d;
}

function waLink(phone, message) {
  const p = waPhone(phone);
  if (!p) return null;
  return "https://wa.me/" + p + "?text=" + encodeURIComponent(message);
}

const ESTADOS = {
  "UNPACKED": "Sin empaquetar",
  "IN_PREPARATION": "En preparacion",
  "PACKED": "Empaquetado",
  "DISPATCHED": "Enviado",
  "READY_FOR_PICKUP": "Listo para retirar",
  "DELIVERED": "Entregado",
  // estados a nivel orden
  "unpacked": "Sin empaquetar",
  "unshipped": "Sin enviar",
  "shipped": "Enviado",
  "delivered": "Entregado",
  "partially_packed": "Parcialmente empaquetado",
  "partially_fulfilled": "Parcialmente enviado",
};
function nombreEstado(st) { return ESTADOS[st] || st; }

function firstName(fullName) {
  if (!fullName) return "";
  return String(fullName).trim().split(/\s+/)[0];
}

function nowAR() {
  return new Date().toLocaleString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

// Busca la orden por ID de API; si no existe, intenta por numero de orden (q)
async function findOrder(input) {
  const clean = String(input).trim().replace(/^#/, "");
  let r = await tn("GET", "/orders/" + clean);
  if (r.ok && r.data && r.data.id) return r.data;
  r = await tn("GET", "/orders?q=" + encodeURIComponent(clean) + "&per_page=5");
  if (r.ok && Array.isArray(r.data)) {
    const exact = r.data.find(o => String(o.number) === clean);
    if (exact) return exact;
    if (r.data.length === 1) return r.data[0];
  }
  return null;
}

function rechazo(fo, intento, r) {
  const actual = nombreEstado(fo.status);
  if (r.status === 400 || r.status === 422) {
    return "La orden ya figura como \"" + actual + "\" y no se puede pasar a \"" + intento + "\".";
  }
  if (r.status === 403) {
    return "Tiendanube rechazo el cambio por permisos (403). Revisar scopes de la app.";
  }
  return "Tiendanube rechazo el cambio a \"" + intento + "\" (error " + r.status + ").";
}

async function getFulfillmentOrder(orderId) {
  const r = await tn("GET", "/orders/" + orderId + "/fulfillment-orders");
  if (r.ok && Array.isArray(r.data) && r.data.length > 0) return r.data[0];
  return null;
}

function orderSummary(order, fo) {
  const phone = (order.customer && order.customer.phone) || order.contact_phone || null;
  return {
    id: order.id,
    number: order.number,
    customer_name: (order.customer && order.customer.name) || order.contact_name || "",
    phone: phone,
    payment_status: order.payment_status,
    shipping_status: order.shipping_status,
    products: (order.products || []).map(p => p.quantity + "x " + p.name),
    address: order.shipping_address
      ? [order.shipping_address.address, order.shipping_address.number,
         order.shipping_address.locality, order.shipping_address.city]
          .filter(Boolean).join(" ")
      : "",
    owner_note: order.owner_note || "",
    shipping_status_label: nombreEstado(order.shipping_status),
    fulfillment: fo ? { id: fo.id, status: fo.status, status_label: nombreEstado(fo.status), tracking: fo.tracking_info || null } : null,
    // Datos del envío que Tiendanube ya conoce (Envío Nube: Correo Argentino / Andreani)
    envio: {
      correo: order.shipping_carrier_name || "",
      opcion: order.shipping_option || "",
      tracking: order.shipping_tracking_number || "",
      url: order.shipping_tracking_url || "",
      transportista: detectarTransportista(order),
    },
  };
}

// Tiendanube dice "Envío Nube" como carrier; el correo real hay que deducirlo
function detectarTransportista(order) {
  const pistas = [
    order.shipping_option_code,
    order.shipping_tracking_url,
    order.shipping_option,
    order.shipping_carrier_name,
    order.shipping_pickup_details && order.shipping_pickup_details.name,
  ].filter(Boolean).join(" ").toLowerCase();
  if (pistas.includes("andreani")) return "Andreani";
  if (pistas.includes("correo") || pistas.includes("correoargentino")) return "Correo Argentino";
  if (pistas.includes("oca")) return "OCA";
  return "";
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "Metodo no permitido" });

  const scanKey = event.headers["x-scan-key"] || event.headers["X-Scan-Key"];
  if (!process.env.SCAN_KEY || scanKey !== process.env.SCAN_KEY) {
    return json(401, { error: "Clave incorrecta" });
  }
  if (!process.env.TN_TOKEN) {
    return json(500, { error: "Falta configurar TN_TOKEN en Netlify" });
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) {
    return json(400, { error: "Body invalido" });
  }

  const { orderId, action } = body;

  // Listado de ordenes pendientes de despacho (no requiere orderId)
  if (action === "pendientes") {
    const r = await tn("GET", "/orders?status=open&per_page=50");
    if (!r.ok) return json(502, { error: "No se pudo listar las ordenes (error " + r.status + ")" });
    const pendientes = (Array.isArray(r.data) ? r.data : [])
      .filter(o => ["unpacked", "unshipped", "partially_packed"].includes(o.shipping_status))
      .map(o => ({
        id: o.id,
        number: o.number,
        name: (o.customer && o.customer.name) || o.contact_name || "",
        city: (o.shipping_address && o.shipping_address.city) || "",
        payment: o.payment_status,
        products: (o.products || []).reduce((a, p) => a + Number(p.quantity || 0), 0),
      }));
    return json(200, { ok: true, orders: pendientes });
  }

  if (!orderId || !action) return json(400, { error: "Faltan orderId o action" });

  const order = await findOrder(orderId);
  if (!order) return json(404, { error: "No se encontro la orden " + orderId });

  const fo = await getFulfillmentOrder(order.id);
  const nombre = firstName((order.customer && order.customer.name) || order.contact_name);
  const phone = (order.customer && order.customer.phone) || order.contact_phone;

  // Solo consulta de datos
  if (action === "info") {
    return json(200, { ok: true, order: orderSummary(order, fo) });
  }

  if (!fo) {
    return json(422, {
      error: "La orden no tiene fulfillment order asociada todavia. " +
             "Puede pasar en ordenes muy recientes; reintentar en unos minutos.",
    });
  }

  // ---- EMPAQUETADO ----
  if (action === "empaquetado") {
    const r = await tn("PATCH", "/orders/" + order.id + "/fulfillment-orders/" + fo.id, {
      status: "PACKED",
    });
    if (!r.ok) return json(422, { error: rechazo(fo, "Empaquetado", r) });

    const msg = "Hola " + nombre + ", te escribimos de SCATTO. " +
      "Tu pedido #" + order.number + " ya esta empaquetado y listo para salir. " +
      "Te avisamos cuando este en camino.";
    return json(200, { ok: true, new_status: "Empaquetado", wa_link: waLink(phone, msg), wa_text: msg });
  }

  // ---- ENVIADO ----
  if (action === "enviado") {
    const payload = { status: "DISPATCHED" };
    if (body.tracking_code) {
      payload.tracking_info = {
        code: body.tracking_code,
        url: body.tracking_url || null,
        notify_customer: true,
      };
    }
    const r = await tn("PATCH", "/orders/" + order.id + "/fulfillment-orders/" + fo.id, payload);
    if (!r.ok) return json(422, { error: rechazo(fo, "Enviado", r) });

    let msg = "Hola " + nombre + ", te escribimos de SCATTO. " +
      "Tu pedido #" + order.number + " ya esta en camino.";
    if (body.tracking_url) msg += " Podes seguirlo aca: " + body.tracking_url;
    else if (body.tracking_code) msg += " Tu codigo de seguimiento es " + body.tracking_code + ".";
    return json(200, { ok: true, new_status: "Enviado", wa_link: waLink(phone, msg), wa_text: msg });
  }

  // ---- ENTREGADO ----
  if (action === "entregado") {
    const r = await tn("PATCH", "/orders/" + order.id + "/fulfillment-orders/" + fo.id, {
      status: "DELIVERED",
    });
    if (!r.ok) return json(422, { error: rechazo(fo, "Entregado", r) });

    // Respaldo de quien recibio, en la nota interna de la orden
    let noteResult = null;
    if (body.recibe || body.dni) {
      const linea = "Entregado " + nowAR() +
        " - Recibio: " + (body.recibe || "sin nombre") +
        (body.dni ? ", DNI " + body.dni : "");
      const nuevaNota = (order.owner_note ? order.owner_note + "\n" : "") + linea;
      const rn = await tn("PUT", "/orders/" + order.id, { owner_note: nuevaNota });
      noteResult = rn.ok ? "guardada" : "fallo al guardar la nota";
    }

    const msg = "Hola " + nombre + ", te confirmamos la entrega de tu pedido #" + order.number + ". " +
      "Gracias por comprar en SCATTO. Cualquier cosa que necesites, escribinos por aca.";
    return json(200, { ok: true, new_status: "Entregado", note: noteResult, wa_link: waLink(phone, msg), wa_text: msg });
  }

  return json(400, { error: "Accion desconocida: " + action });
};
