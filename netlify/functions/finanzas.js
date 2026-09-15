// netlify/functions/finanzas.js — v8
// Novedades: el enriquecimiento (Tiendanube + MercadoLibre) corre siempre,
// así el panel muestra el comprador en cada venta; y se agrega una
// descripción corta del producto para la tabla.
// Usa MP_TOKEN, TN_TOKEN y ALERT_KEY (variables ya cargadas en Netlify).

// ====== NÚMEROS DEL NEGOCIO (editá acá cuando cambien) ======
const COSTO_UNITARIO = 10000;   // costo por unidad puesta en Argentina (valor de ejemplo)
const RESERVA_UNITARIA = 10500; // lo que se aparta por unidad vendida, con colchón (valor de ejemplo)
const FIJOS_MENSUALES = 100000; // plataforma + impuestos + ads + packaging (valor de ejemplo)
const TN_STORE_ID = "7747275";  // tu tienda en Tiendanube
const PRECIO_REF_ML = 25000;    // precio aprox. por unidad en ML (valor de ejemplo): se usa para estimar
                                // cantidades cuando el pago no trae el detalle
                                // (actualizalo si cambiás mucho el precio de lista)
// ============================================================

function fechaART(date) {
  const art = new Date(date.getTime() - 3 * 60 * 60 * 1000);
  return art.toISOString().slice(0, 10);
}

function mesActualART() {
  return fechaART(new Date()).slice(0, 7);
}

function rangoDelMes(mes) {
  const [y, m] = mes.split("-").map(Number);
  const desde = new Date(Date.UTC(y, m - 1, 1, 3, 0, 0));
  const hasta = new Date(Date.UTC(y, m, 1, 3, 0, 0));
  return { desde, hasta };
}

// "FEDERICO AMICHETTI" / "ulises levian" → "Federico Amichetti" / "Ulises Levian"
const PARTICULAS = new Set(["de", "del", "la", "las", "los", "y", "e", "da", "do", "dos", "das", "van", "von", "di"]);
function formatearNombre(n) {
  const s = String(n || "").trim().replace(/\s+/g, " ");
  if (!s) return "";
  return s
    .toLowerCase()
    .split(" ")
    .map((p, i) => {
      if (i > 0 && PARTICULAS.has(p)) return p;
      // maneja guiones y apóstrofes: "d'angelo", "garcía-lópez"
      return p.replace(/(^|[-'])(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase());
    })
    .join(" ");
}

// Estado de envío normalizado (Tiendanube y ML usan nombres distintos)
function normalizarEnvio(st, sub) {
  const s = String(st || "").toLowerCase();
  const ss = String(sub || "").toLowerCase();
  if (!s) return "";
  if (s.includes("deliver") && !s.includes("not_")) return "entregado";
  if (s === "not_delivered" || s.includes("cancel") || ss.includes("returning") || ss.includes("lost")) return "problema";
  if (s.includes("shipped") || s.includes("dispatched") || s === "in_transit") return "enviado";
  // ML puede dejar el estado en ready_to_ship y contar el avance en el sub-estado
  if (["picked_up", "in_hub", "in_transit", "out_for_delivery", "in_packing_list", "dropped_off", "at_customs", "delivered_to_carrier"].some((k) => ss.includes(k))) return "enviado";
  if (s.includes("pack") || s.includes("pending") || s.includes("handling") || s.includes("ready_to_ship") || s.includes("unship")) return "pendiente";
  return "";
}
const ENVIO_LABEL = { pendiente: "A despachar", enviado: "En camino", entregado: "Entregado", problema: "Problema" };

// Nombre corto del producto para la tabla del panel
function acortarDesc(d) {
  const t = String(d || "").toLowerCase();
  if (t.includes("rejilla") || t.includes("salida de aire")) return "Soporte Auto Rejilla";
  if (t.includes("soporte")) return "Soporte Auto";
  return String(d || "Venta").slice(0, 26);
}

// ---- Mercado Pago ----

async function miUserId() {
  const res = await fetch("https://api.mercadopago.com/users/me", {
    headers: { Authorization: `Bearer ${process.env.MP_TOKEN}` },
  });
  if (!res.ok) throw new Error(`MP /users/me: ${res.status}`);
  return (await res.json()).id;
}

async function buscarPagos(desde, hasta) {
  const pagos = [];
  let offset = 0;
  while (true) {
    const url =
      "https://api.mercadopago.com/v1/payments/search" +
      "?sort=date_approved&criteria=desc&range=date_approved" +
      `&begin_date=${desde.toISOString()}` +
      `&end_date=${hasta.toISOString()}` +
      `&limit=50&offset=${offset}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.MP_TOKEN}` },
    });
    if (!res.ok) throw new Error(`MP respondió ${res.status}`);
    const data = await res.json();
    pagos.push(...(data.results || []));
    offset += 50;
    if (!data.paging || offset >= data.paging.total || pagos.length >= 800) break;
  }
  return pagos;
}

// ---- Tiendanube ----

async function tnGet(path) {
  try {
    const res = await fetch(`https://api.tiendanube.com/v1/${TN_STORE_ID}${path}`, {
      headers: {
        Authentication: `bearer ${process.env.TN_TOKEN}`,
        "User-Agent": "SCATTO Finanzas (scatto.com.ar)",
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

async function ordenesTN(desde, hasta) {
  const ordenes = [];
  for (let page = 1; page <= 5; page++) {
    const data = await tnGet(
      `/orders?created_at_min=${desde.toISOString()}&created_at_max=${hasta.toISOString()}` +
      `&per_page=100&page=${page}`
    );
    if (!data || !Array.isArray(data) || data.length === 0) break;
    ordenes.push(...data);
    if (data.length < 100) break;
  }
  return ordenes;
}

// Comisiones de las pasarelas de Tiendanube (la API no informa el neto:
// lo calculamos). Verificado con la orden #124: $32.081 cobrados → $30.376,89
// acreditados = 5,31%. Actualizá estos valores si cambian las comisiones.
// Pago Nube (dLocal): verificado con la orden #124 en 1 pago → 5,31%.
// Payway/MODO (Visa vía Credicoop): verificado con 2 liquidaciones en 3 cuotas:
//   arancel 3% + costo del plan de cuotas + IVA 21% sobre ambos ≈ 20-21%.
//   El costo por cuotas cambia con el tiempo; actualizá la tabla con cada liquidación.
// Pago Nube cambió de plan el 14/09/2026: de "7 días" (4,39%+IVA) a "14 días" (3,49%+IVA).
const COMISION_PASARELA = {
  "pago-nube": { base: 0.0422, cuotas: {}, historico: [{ hasta: "2026-09-13", base: 0.0531 }] },
  "modo":      { base: 0.03,   cuotas: { 1: 0, 3: 0.14, 6: 0.25, 12: 0.40 }, iva: 0.21 },
  "_default":  { base: 0.0531, cuotas: {} },
};

// Tasa efectiva según pasarela y cantidad de cuotas
function tasaComision(gw, cuotas, fecha) {
  const c = COMISION_PASARELA[gw] || COMISION_PASARELA._default;
  const n = parseInt(cuotas, 10) || 1;
  // Tasa vigente según la fecha de la venta (cambios de plan)
  let base = c.base;
  if (c.historico && fecha) {
    for (const h of c.historico) if (fecha <= h.hasta) { base = h.base; break; }
  }
  const cc = { ...c, base };
  return calcTasa(cc, n);
}
function calcTasa(c, n) {
  const extra = c.cuotas[n] != null ? c.cuotas[n] : (n > 1 ? (c.cuotas[3] || 0) : 0);
  const iva = c.iva || 0;
  return (c.base + extra) * (1 + iva);
}

// Marca con la que guardamos el neto exacto dentro de "Tus notas" de la orden
const MARCA_NETO = /\[\[NETO:(-?[\d.]+)\]\]/;

function netoManualDe(orden) {
  const m = MARCA_NETO.exec(String(orden.owner_note || ""));
  if (!m) return null;
  const n = parseFloat(m[1]);
  return isNaN(n) ? null : Math.round(n);
}

// Montos de la orden de Tiendanube: bruto, envío y neto
// (exacto si lo cargaste a mano; estimado por comisión si todavía no)
function montosTN(orden) {
  const num = (x) => {
    const n = parseFloat(x);
    return isNaN(n) ? 0 : n;
  };
  const bruto = num(orden.total);
  const envio = num(orden.shipping_cost_customer || orden.shipping_cost_owner || 0);
  const gw = String(orden.gateway || "").toLowerCase();

  const manual = !gw || gw.includes("offline") || gw.includes("custom");
  const cuotas = (orden.payment_details && orden.payment_details.installments) || 1;
  const fechaOrden = fechaART(new Date(orden.created_at));
  const tasa = manual ? 0 : tasaComision(gw, cuotas, fechaOrden);

  const cargado = netoManualDe(orden);
  if (cargado != null) {
    return { bruto: Math.round(bruto), neto: cargado, neto_estimado: false, envio: Math.round(envio), cuotas };
  }

  return {
    bruto: Math.round(bruto),
    neto: Math.round(bruto * (1 - tasa)),
    neto_estimado: !manual,
    envio: Math.round(envio),
    cuotas,
  };
}

function clienteTN(orden) {
  const c = orden.customer || {};
  const b = orden.billing_address || {};
  const bObj = typeof b === "object" ? b : {};
  const nombre = c.name || [bObj.first_name, bObj.last_name].filter(Boolean).join(" ") || "";
  const doc = String(c.identification || orden.contact_identification || bObj.identification || "");
  const email = c.email || orden.contact_email || "";

  // Domicilio de facturación: Tiendanube lo guarda en campos billing_* planos
  const calleB = [typeof orden.billing_address === "string" ? orden.billing_address : bObj.address,
                  orden.billing_number || bObj.number].filter(Boolean).join(" ").trim();
  const pisoB = orden.billing_floor || bObj.floor || "";
  let dom = {
    direccion: [calleB, pisoB].filter(Boolean).join(" "),
    ciudad: orden.billing_city || bObj.city || orden.billing_locality || bObj.locality || "",
    provincia: orden.billing_province || bObj.province || "",
    cp: orden.billing_zipcode || bObj.zipcode || "",
  };
  // Si no hay domicilio de facturación, usar el de envío
  if (!dom.direccion && orden.shipping_address && typeof orden.shipping_address === "object") {
    const s = orden.shipping_address;
    dom = {
      direccion: [s.address, s.number, s.floor].filter(Boolean).join(" ").trim(),
      ciudad: s.city || s.locality || "",
      provincia: s.province || "",
      cp: s.zipcode || "",
    };
  }
  return { nombre, doc, email, ...dom, cond_iva: "", envio_estado: normalizarEnvio(orden.shipping_status) };
}

function viaTN(orden) {
  const g = String(orden.gateway || orden.gateway_name || "").toLowerCase();
  if (g.includes("mercado")) return "MP";
  if (g.includes("nube") || g.includes("pagonube") || g.includes("pago nube")) return "PagoNube";
  if (g.includes("offline") || g.includes("custom") || g === "") return "Manual";
  return orden.gateway_name || orden.gateway || "Otro";
}

// ---- MercadoLibre ----
// Usa el token guardado por ml-auth.js en Supabase, y lo renueva solo al vencer.

function sbHeaders(extra) {
  return Object.assign(
    {
      apikey: process.env.SUPABASE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_KEY}`,
    },
    extra || {}
  );
}

async function leerTokensML() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) return null;
  try {
    const res = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/ml_tokens?id=eq.1&select=*`,
      { headers: sbHeaders() }
    );
    if (!res.ok) return null;
    const filas = await res.json();
    const t = filas && filas[0];
    if (!t) return null;
    return { ...t, expira: new Date(t.expira).getTime() };
  } catch (_) {
    return null;
  }
}

async function guardarTokensML(tokens) {
  try {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/ml_tokens`, {
      method: "POST",
      headers: sbHeaders({
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      }),
      body: JSON.stringify({
        id: 1,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        user_id: tokens.user_id,
        expira: new Date(tokens.expira).toISOString(),
        actualizado: new Date().toISOString(),
      }),
    });
  } catch (_) {}
}

async function tokenML() {
  const t = await leerTokensML();
  if (!t || !t.refresh_token) return null;

  // Todavía válido (con 5 minutos de margen)
  if (t.expira - Date.now() > 5 * 60 * 1000) return t.access_token;

  // Vencido: renovar
  try {
    const r = await fetch("https://api.mercadolibre.com/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: process.env.ML_APP_ID,
        client_secret: process.env.ML_SECRET,
        refresh_token: t.refresh_token,
      }),
    });
    const nuevo = await r.json();
    if (!r.ok || !nuevo.access_token) return null;
    await guardarTokensML({
      access_token: nuevo.access_token,
      refresh_token: nuevo.refresh_token || t.refresh_token,
      user_id: String(nuevo.user_id || t.user_id || ""),
      expira: Date.now() + (nuevo.expires_in || 21600) * 1000,
      actualizado: new Date().toISOString(),
    });
    return nuevo.access_token;
  } catch (_) {
    return null;
  }
}

async function mlGet(path, token) {
  if (!token) return null;
  try {
    const res = await fetch(`https://api.mercadolibre.com${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

async function datosOrdenML(orderId, token) {
  const [orden, billing] = await Promise.all([
    mlGet(`/orders/${orderId}`, token),
    mlGet(`/orders/${orderId}/billing_info`, token),
  ]);

  const out = { nombre: "", doc: "", unidades: 0, direccion: "", ciudad: "", provincia: "", cp: "", cond_iva: "", envio_estado: "" };

  if (orden) {
    // Estado del envío: hay que pedirlo aparte
    const shipId = orden.shipping && orden.shipping.id;
    if (shipId) {
      const ship = await mlGet(`/shipments/${shipId}`, token);
      if (ship && ship.status) out.envio_estado = normalizarEnvio(ship.status, ship.substatus);
    } else if (orden.shipping && orden.shipping.status) {
      out.envio_estado = normalizarEnvio(orden.shipping.status);
    }
    const b = orden.buyer || {};
    out.nombre = [b.first_name, b.last_name].filter(Boolean).join(" ").trim() || b.nickname || "";
    const items = orden.order_items || [];
    out.unidades = items.reduce((acc, it) => acc + (parseInt(it.quantity, 10) || 0), 0);
  }

  if (billing) {
    const bi = billing.billing_info || billing;
    const nombreBI = [bi.name, bi.first_name, bi.last_name].filter(Boolean).join(" ").trim();
    if (nombreBI) out.nombre = nombreBI;
    if (bi.doc_number) out.doc = `${bi.doc_type || ""} ${bi.doc_number}`.trim();
    // La lista additional_info trae el nombre completo real (los datos básicos
    // del comprador vienen con iniciales por privacidad) y a veces el documento
    if (Array.isArray(bi.additional_info)) {
      const val = (t) => {
        const x = bi.additional_info.find((i) => i.type === t);
        return x && x.value ? String(x.value).trim() : "";
      };
      const razon = val("BUSINESS_NAME");
      const nombreAI = razon || [val("FIRST_NAME"), val("LAST_NAME")].filter(Boolean).join(" ");
      if (nombreAI) out.nombre = nombreAI;
      if (!out.doc && val("DOC_NUMBER")) out.doc = `${val("DOC_TYPE")} ${val("DOC_NUMBER")}`.trim();
      // Domicilio y condición fiscal (lo que ML muestra en "Datos para su factura")
      out.direccion = [val("STREET_NAME"), val("STREET_NUMBER")].filter(Boolean).join(" ");
      out.ciudad = val("CITY_NAME");
      out.provincia = val("STATE_NAME");
      out.cp = val("ZIP_CODE");
      out.cond_iva = val("TAXPAYER_TYPE");
    }
  }

  return out;
}

// ---- helpers de pagos MP ----

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

function unidadesDe(p) {
  const items = (p.additional_info && p.additional_info.items) || [];
  const total = items.reduce((acc, it) => acc + (parseInt(it.quantity, 10) || 0), 0);
  return total > 0 ? total : 1;
}

function esML(p) {
  if (p.order && p.order.type === "mercadolibre") return true;
  return (p.description || "").toLowerCase().includes("orden de venta");
}

function compradorDe(p) {
  const ap = (p.additional_info && p.additional_info.payer) || {};
  const py = p.payer || {};
  const nombre = [ap.first_name, ap.last_name].filter(Boolean).join(" ").trim() ||
    [py.first_name, py.last_name].filter(Boolean).join(" ").trim() || "";
  const ident = py.identification || {};
  const doc = ident.number
    ? `${ident.type || ""} ${ident.number}`.trim()
    : "";
  const email = py.email || "";
  return { nombre, doc, email };
}

function claveVenta(p) {
  if (p.order && p.order.id) return "orden-" + p.order.id;
  return "pago-" + p.id;
}

// ---- armado de ventas ----

function ventasDesdeMP(pagos, myId) {
  const cobrados = pagos.filter(
    (p) =>
      p.status === "approved" &&
      String(collectorDe(p)) === String(myId) &&
      p.operation_type !== "account_fund" &&
      p.operation_type !== "money_transfer" &&
      p.operation_type !== "partition_transfer" &&
      String(payerIdDe(p)) !== String(myId)
  );

  const grupos = {};
  for (const p of cobrados) {
    const k = claveVenta(p);
    if (!grupos[k]) {
      const c = compradorDe(p);
      grupos[k] = {
        id: (p.order && p.order.id) || p.id,
        es_ml: esML(p),
        ref_tn: null,
        fecha: fechaART(new Date(p.date_approved)),
        canal: esML(p) ? "ML" : "Tienda",
        via: "MP",
        desc: (p.description || "Venta").slice(0, 60),
        unidades: unidadesDe(p),
        bruto: 0,
        neto: 0,
        liberado: true,
        libera: null,
        comprador: c.nombre,
        documento: c.doc,
        email: c.email,
        direccion: "", ciudad: "", provincia: "", cp: "", cond_iva: "", envio_estado: "",
        orden_tn: "",
      };
    }
    const g = grupos[k];
    g.bruto += Math.round(p.transaction_amount || 0);
    g.neto += Math.round(netoDe(p));
    g.unidades = Math.max(g.unidades, unidadesDe(p));
    const f = fechaART(new Date(p.date_approved));
    if (f < g.fecha) g.fecha = f;
    if (p.money_release_status !== "released") g.liberado = false;
    if (p.money_release_date) {
      const fl = fechaART(new Date(p.money_release_date));
      if (!g.libera || fl > g.libera) g.libera = fl;
    }
    const c = compradorDe(p);
    if (!g.comprador && c.nombre) g.comprador = c.nombre;
    if (!g.documento && c.doc) g.documento = c.doc;
    if (!g.email && c.email) g.email = c.email;
    if (!g.es_ml && !g.ref_tn && p.external_reference) {
      g.ref_tn = String(p.external_reference).replace(/\D/g, "");
    }
  }
  return Object.values(grupos);
}

function fusionarConTN(ventasMP, ordenes) {
  const porRef = {};
  for (const v of ventasMP) if (v.ref_tn) porRef[v.ref_tn] = v;

  for (const o of ordenes) {
    if (o.status === "cancelled") continue;
    if (o.payment_status !== "paid" && o.payment_status !== "authorized") continue;

    const cli = clienteTN(o);
    const num = o.number ? "#" + o.number : "";
    const productos = (o.products || []);
    const unidades = productos.reduce((a, pr) => a + (parseInt(pr.quantity, 10) || 0), 0) || 1;
    const desc = productos.length
      ? productos.map((pr) => pr.name).join(" | ").slice(0, 60)
      : "Venta Tiendanube";

    const existente = porRef[String(o.id)];
    const m = montosTN(o);
    if (existente) {
      if (cli.nombre) existente.comprador = cli.nombre;
      if (cli.doc) existente.documento = cli.doc;
      if (cli.email) existente.email = cli.email;
      Object.assign(existente, { direccion: cli.direccion, ciudad: cli.ciudad, provincia: cli.provincia, cp: cli.cp, envio_estado: cli.envio_estado });
      existente.orden_tn = num;
      existente.envio = m.envio;
      if (unidades > 0) existente.unidades = unidades;
      continue;
    }

    const fechaO = fechaART(new Date(o.created_at));
    const gemela = ventasMP.find(
      (v) => v.canal === "Tienda" && !v.ref_tn && v.fecha === fechaO &&
             Math.abs(v.bruto - m.bruto) <= 2
    );
    if (gemela) {
      if (cli.nombre) gemela.comprador = cli.nombre;
      if (cli.doc) gemela.documento = cli.doc;
      if (cli.email) gemela.email = cli.email;
      Object.assign(gemela, { direccion: cli.direccion, ciudad: cli.ciudad, provincia: cli.provincia, cp: cli.cp, envio_estado: cli.envio_estado });
      gemela.orden_tn = num;
      gemela.envio = m.envio;
      continue;
    }

    // No pasó por MP (Pago Nube, MODO, manual): usamos los montos de Tiendanube
    ventasMP.push({
      id: o.id,
      es_ml: false,
      ref_tn: String(o.id),
      fecha: fechaO,
      canal: "Tienda",
      via: viaTN(o),
      desc,
      unidades,
      bruto: m.bruto,
      neto: m.neto,          // calculado con la comisión de la pasarela
      neto_estimado: m.neto_estimado,
      cuotas: m.cuotas,
      envio: m.envio,        // parte del cobro que se va al correo
      liberado: null,
      libera: null,
      comprador: cli.nombre,
      documento: cli.doc,
      email: cli.email,
      direccion: cli.direccion, ciudad: cli.ciudad, provincia: cli.provincia, cp: cli.cp, cond_iva: "",
      envio_estado: cli.envio_estado,
      orden_tn: num,
    });
  }
}

async function enriquecerML(ventas) {
  const token = await tokenML();
  if (!token) return;
  await Promise.all(
    ventas
      .filter((v) => v.es_ml)
      .map(async (v) => {
        const datos = await datosOrdenML(v.id, token);
        if (!datos) return;
        if (datos.nombre) v.comprador = datos.nombre;
        if (datos.doc) v.documento = datos.doc;
        if (datos.direccion) v.direccion = datos.direccion;
        if (datos.ciudad) v.ciudad = datos.ciudad;
        if (datos.provincia) v.provincia = datos.provincia;
        if (datos.cp) v.cp = datos.cp;
        if (datos.cond_iva) v.cond_iva = datos.cond_iva;
        if (datos.envio_estado) v.envio_estado = datos.envio_estado;
        if (datos.unidades > 0 && datos.unidades !== v.unidades) {
          v.unidades = datos.unidades;
        }
      })
  );
}

// CSV con separador ; (configuración regional argentina) y BOM para Excel
function armarCSV(ventas) {
  const esc = (v) => {
    const s = String(v == null ? "" : v);
    return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const filas = [
    ["Fecha", "Canal", "Via", "Detalle", "Unidades", "Bruto", "Neto", "Envio", "Margen",
     "Comprador", "Documento", "Cond IVA", "Direccion", "Ciudad", "Provincia", "CP", "Email",
     "Orden TN", "Envio", "Liberado", "Fecha liberacion", "ID orden/pago"],
    ...ventas.map((v) => [
      v.fecha, v.canal, v.via, v.desc, v.unidades, v.bruto,
      v.neto == null ? "" : v.neto,
      v.envio || 0,
      v.margen == null ? "" : v.margen,
      v.comprador, v.documento, v.cond_iva || "", v.direccion || "", v.ciudad || "", v.provincia || "", v.cp || "", v.email,
      v.orden_tn, v.envio_label || "",
      v.liberado == null ? "" : v.liberado ? "SI" : "NO",
      v.libera || "", v.id,
    ]),
  ];
  const cuerpo = filas.map((f) => f.map(esc).join(";")).join("\r\n");
  return "\uFEFF" + cuerpo;
}

exports.handler = async (event) => {
  const qs = event.queryStringParameters || {};
  if (qs.key !== process.env.ALERT_KEY) {
    return { statusCode: 401, body: JSON.stringify({ error: "No autorizado" }) };
  }

  // ---- Guardar el neto exacto de una orden de Tiendanube ----
  if (event.httpMethod === "POST") {
    try {
      const body = JSON.parse(event.body || "{}");
      const ordenId = String(body.orden_id || "").replace(/\D/g, "");
      const neto = parseFloat(body.neto);
      if (!ordenId) throw new Error("Falta el id de la orden");

      const actual = await tnGet(`/orders/${ordenId}`);
      if (!actual) throw new Error("No pude leer la orden en Tiendanube");

      // Conservamos tus notas y sólo reemplazamos la marca del neto
      const notaPrevia = String(actual.owner_note || "").replace(MARCA_NETO, "").trim();
      const nota = isNaN(neto)
        ? notaPrevia
        : (notaPrevia ? notaPrevia + "\n" : "") + `[[NETO:${neto.toFixed(2)}]]`;

      const res = await fetch(
        `https://api.tiendanube.com/v1/${TN_STORE_ID}/orders/${ordenId}`,
        {
          method: "PUT",
          headers: {
            Authentication: `bearer ${process.env.TN_TOKEN}`,
            "User-Agent": "SCATTO Finanzas (scatto.com.ar)",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ owner_note: nota }),
        }
      );
      if (!res.ok) {
        throw new Error(`Tiendanube respondió ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ ok: true, neto: isNaN(neto) ? null : Math.round(neto) }),
      };
    } catch (err) {
      return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
  }

  const mes = /^\d{4}-\d{2}$/.test(qs.mes || "") ? qs.mes : mesActualART();

  try {
    const { desde, hasta } = rangoDelMes(mes);
    const [myId, pagos, ordenes] = await Promise.all([
      miUserId(),
      buscarPagos(desde, hasta),
      ordenesTN(desde, hasta),
    ]);

    const ventasTodas = ventasDesdeMP(pagos, myId);
    fusionarConTN(ventasTodas, ordenes);

    let ventas = ventasTodas.filter((v) => v.fecha.startsWith(mes));

    // Nombres y cantidades reales de ML (siempre, para que el panel muestre el comprador)
    await enriquecerML(ventas);

    ventas = ventas
      .map((v) => {
        // ML sin detalle de items: estimar unidades por el monto bruto
        // (ej: bruto ≈ 2 × precio de lista → 2 unidades)
        if (v.es_ml) {
          const est = Math.max(1, Math.round(v.bruto / PRECIO_REF_ML));
          if (est > v.unidades) v.unidades = est;
        }
        return {
          ...v,
          comprador: formatearNombre(v.comprador),
          direccion: formatearNombre(v.direccion),
          ciudad: formatearNombre(v.ciudad),
          provincia: formatearNombre(v.provincia),
          envio_label: ENVIO_LABEL[v.envio_estado] || "",
          desc_corta: acortarDesc(v.desc),
          // El envío cobrado al cliente se le paga al correo: no es margen
          margen: v.neto == null
            ? null
            : v.neto - (v.envio || 0) - COSTO_UNITARIO * v.unidades,
        };
      })
      .sort((a, b) => (a.fecha < b.fecha ? 1 : -1));

    // ---- Diagnóstico TN: ?debug=tn&orden=124 (muestra los campos de montos) ----
    if (qs.debug === "tn") {
      const objetivo = qs.orden
        ? ordenes.find((o) => String(o.number) === String(qs.orden))
        : ordenes.find((o) => viaTN(o) !== "MP");
      if (!objetivo) {
        return { statusCode: 200, body: "No encontré esa orden en el mes elegido." };
      }
      const claves = Object.keys(objetivo)
        .filter((k) => /total|net|paid|amount|cost|discount|ship/i.test(k))
        .map((k) => `${k}: ${JSON.stringify(objetivo[k])}`)
        .join("\n");
      return {
        statusCode: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body:
          `Orden #${objetivo.number} (gateway: ${objetivo.gateway || objetivo.gateway_name})\n\n` +
          `Campos de montos:\n${claves}\n\n` +
          `--- orden completa ---\n${JSON.stringify(objetivo, null, 2).slice(0, 4000)}`,
      };
    }

    // ---- Diagnóstico envío ML: ?debug=envio&orden=ID ----
    if (qs.debug === "envio") {
      const token = await tokenML();
      const v = qs.orden ? ventas.find((x) => String(x.id) === String(qs.orden)) : ventas.find((x) => x.es_ml);
      if (!v || !token) return { statusCode: 200, body: "No encontré la venta o no hay token de ML." };
      const orden = await mlGet(`/orders/${v.id}`, token);
      const shipId = orden && orden.shipping && orden.shipping.id;
      const ship = shipId ? await mlGet(`/shipments/${shipId}`, token) : null;
      return {
        statusCode: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body:
          `Venta ${v.id} · shipping.id: ${shipId || "—"}\n` +
          `status: ${ship ? ship.status : "?"} · substatus: ${ship ? ship.substatus : "?"}\n` +
          `→ panel: ${normalizarEnvio(ship && ship.status, ship && ship.substatus) || "(sin estado)"}\n\n` +
          (ship ? JSON.stringify({ status: ship.status, substatus: ship.substatus, logistic_type: ship.logistic_type, tracking_number: ship.tracking_number, date_first_printed: ship.date_first_printed }, null, 2) : "sin datos de envío"),
      };
    }

    // ---- Diagnóstico ML: ?debug=ml (muestra qué responde la API de MercadoLibre) ----
    if (qs.debug === "ml") {
      const v = ventas.find((x) => x.es_ml);
      if (!v) {
        return { statusCode: 200, body: "No hay ventas de ML en el mes elegido." };
      }
      const token = await tokenML();
      if (!token) {
        return {
          statusCode: 200,
          body: "No hay token de ML guardado. Conectá tu cuenta entrando a /.netlify/functions/ml-auth?key=TU_CLAVE",
        };
      }
      const probar = async (path) => {
        try {
          const r = await fetch("https://api.mercadolibre.com" + path, {
            headers: { Authorization: `Bearer ${token}` },
          });
          const txt = (await r.text()).slice(0, 400);
          return `${path}\n  → HTTP ${r.status}: ${txt}`;
        } catch (e) {
          return `${path}\n  → error de red: ${e.message}`;
        }
      };
      const a = await probar(`/orders/${v.id}`);
      const b = await probar(`/orders/${v.id}/billing_info`);
      return {
        statusCode: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: `Orden ML de prueba: ${v.id}\n\n${a}\n\n${b}`,
      };
    }

    // ---- Exportación CSV para facturación ----
    if (qs.formato === "csv") {
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="scatto-ventas-${mes}.csv"`,
        },
        body: armarCSV(ventas),
      };
    }

    const sum = (arr, f) => arr.reduce((a, v) => a + f(v), 0);
    const conNeto = ventas.filter((v) => v.neto != null);
    const sinNeto = ventas.filter((v) => v.neto == null);

    const unidadesMes = sum(ventas, (v) => v.unidades);
    const netoMes = sum(conNeto, (v) => v.neto);
    const reposicionMes = unidadesMes * RESERVA_UNITARIA;
    const disponibleTrasReposicion = Math.max(0, netoMes - reposicionMes);
    const operacionMes = Math.min(disponibleTrasReposicion, FIJOS_MENSUALES);
    const crecimientoMes = Math.max(0, disponibleTrasReposicion - FIJOS_MENSUALES);

    const resumen = {
      mes,
      ventas: ventas.length,
      unidades: unidadesMes,
      bruto: sum(ventas, (v) => v.bruto),
      neto: netoMes,
      margen: sum(conNeto, (v) => v.margen),
      sin_neto: sinNeto.length,
      bruto_sin_neto: sum(sinNeto, (v) => v.bruto),
      potes: {
        reposicion: reposicionMes,
        operacion: operacionMes,
        fijos_objetivo: FIJOS_MENSUALES,
        crecimiento: crecimientoMes,
      },
      parametros: {
        costo_unitario: COSTO_UNITARIO,
        reserva_unitaria: RESERVA_UNITARIA,
      },
    };

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ resumen, ventas }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
