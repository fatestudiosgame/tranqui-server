const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const fs = require('fs');
const dotenv = require('dotenv');

dotenv.config();

// --- Cargar clave de servicio ---
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log('✅ Clave de servicio cargada desde variable de entorno');
  } catch (e) {
    console.error('❌ Error al parsear FIREBASE_SERVICE_ACCOUNT:', e.message);
    process.exit(1);
  }
} else {
  try {
    const keyPath = './firebase-key.json';
    if (!fs.existsSync(keyPath)) {
      console.error('❌ No se encuentra firebase-key.json');
      process.exit(1);
    }
    serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    console.log('✅ Clave de servicio cargada desde firebase-key.json');
  } catch (e) {
    console.error('❌ Error al leer firebase-key.json:', e.message);
    process.exit(1);
  }
}

// --- Inicializar Firebase Admin ---
try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('✅ Firebase Admin inicializado correctamente');
} catch (e) {
  console.error('❌ Error al inicializar Firebase Admin:', e.message);
  process.exit(1);
}

const db = admin.firestore();

// =========================================================
// CATEGORÍAS VÁLIDAS
// =========================================================
const CATEGORIAS_VALIDAS = [
  'restaurante', 'cafeteria', 'bar', 'reposteria', 'elaborador_alimentos',
  'mercado', 'ropa_calzado', 'ferreteria', 'farmacia', 'electronica', 'papeleria',
  'peluqueria', 'salon_belleza', 'tatuajes',
  'taller_electronica', 'taller_mecanico', 'costura',
  'sala_juegos', 'billar', 'piscina', 'eventos',
  'consulta_medica', 'veterinaria',
  'taxi', 'transporte_provincial', 'alquiler_vehiculos',
  'fotografia', 'gestoria', 'tutorias', 'recargas',
  'otros',
];

// =========================================================
// USUARIOS ADMIN
// =========================================================
const ADMIN_USERNAMES = ['noblesse'];

function esAdmin(username) {
  return ADMIN_USERNAMES.includes(username);
}

// =========================================================
// ⭐ JERARQUÍA DE PLANES (regla upgrade/downgrade)
// =========================================================
function rankPlan(plan) {
  const t = (plan || '').toLowerCase();
  if (t.includes('oro')) return 3;
  if (t.includes('plata')) return 2;
  if (t.includes('bronce')) return 1;
  return 0;
}

function duracionDiasPlan(plan) {
  const r = rankPlan(plan);
  if (r === 3) return 360;
  if (r === 2) return 180;
  if (r === 1) return 30;
  return 30;
}

// =========================================================
// ⭐ AUTO-LIMPIEZA DE VIP (Versión Segura: Solo alerta, NO modifica la BD)
// =========================================================
async function sincronizarEstadoVip(negocioId, negocioData) {
  if (negocioData.esVip && negocioData.propietarioUsername) {
    // Verificar si el propietario tiene una licencia vigente en la colección 'licencias'
    const licenciasSnap = await db.collection('licencias')
      .where('username', '==', negocioData.propietarioUsername)
      .get();
    
    let tieneLicenciaVigente = false;
    const ahoraMs = Date.now();
    
    licenciasSnap.forEach((d) => {
      const licData = d.data();
      if (licData.fechaActivacion) {
        const inicio = licData.fechaActivacion.toDate().getTime();
        const fin = inicio + duracionDiasPlan(licData.tipoPlan) * 86400000;
        if (fin > ahoraMs) {
          tieneLicenciaVigente = true;
        }
      }
    });

    // ⚠️ CAMBIO CRÍTICO: Si NO tiene licencia vigente, SOLO ALERTAMOS en consola, NO BORRAMOS
    if (!tieneLicenciaVigente) {
      console.warn(`⚠️ [ALERTA VIP] El negocio "${negocioData.nombre}" (${negocioId}) del usuario @${negocioData.propietarioUsername} aparece como VIP pero NO tiene licencia vigente en la colección 'licencias'. Revisa manualmente.`);
      // ❌ NO hacemos el .update() para evitar que se desactive solo
    }
  }
  return negocioData.esVip; // Siempre devuelve el estado que ya tiene en la BD
}

// =========================================================
// ⭐ DISPARAR GENERACIÓN DE PÁGINAS WEB (GitHub Actions)
// =========================================================
let _ultimoDisparoPaginas = 0;

async function dispararGeneracionPaginas(motivo) {
  const token = process.env.GH_WORKFLOW_TOKEN;
  if (!token) {
    console.log('⚠️ Sin GH_WORKFLOW_TOKEN: no se dispara el workflow de páginas');
    return;
  }
  const ahora = Date.now();
  if (ahora - _ultimoDisparoPaginas < 60000) {
    console.log('⏳ Disparo de páginas en debounce, ignorando (' + motivo + ')');
    return;
  }
  _ultimoDisparoPaginas = ahora;
  try {
    const res = await fetch(
      'https://api.github.com/repos/fatestudiosgame/tranqui-web/actions/workflows/generar-paginas-vip.yml/dispatches',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main' }),
      }
    );
    console.log('🚀 Workflow de páginas disparado (' + motivo + ') → HTTP ' + res.status);
  } catch (e) {
    console.error('❌ Error disparando workflow de páginas:', e.message);
  }
}

// =========================================================
// HELPER: Validar categorías
// =========================================================
function validarCategorias(categoriaPrincipal, categoriasSecundarias) {
  if (!categoriaPrincipal || typeof categoriaPrincipal !== 'string') {
    return { valido: false, error: 'La categoría principal es obligatoria' };
  }
  if (!CATEGORIAS_VALIDAS.includes(categoriaPrincipal)) {
    return { valido: false, error: `Categoría principal inválida: ${categoriaPrincipal}` };
  }
  const secundarias = categoriasSecundarias || [];
  if (!Array.isArray(secundarias)) {
    return { valido: false, error: 'categoriasSecundarias debe ser un array' };
  }
  if (secundarias.length > 2) {
    return { valido: false, error: 'Máximo 2 categorías secundarias' };
  }
  if (new Set(secundarias).size !== secundarias.length) {
    return { valido: false, error: 'Categorías secundarias repetidas' };
  }
  if (secundarias.includes(categoriaPrincipal)) {
    return { valido: false, error: 'La principal no puede repetirse en secundarias' };
  }
  for (const sec of secundarias) {
    if (!CATEGORIAS_VALIDAS.includes(sec)) {
      return { valido: false, error: `Categoría secundaria inválida: ${sec}` };
    }
  }
  return { valido: true };
}

// =========================================================
// ⭐ 100 NIVELES (Generados matemáticamente para progresión justa)
// =========================================================
function generarNiveles() {
  const niveles = [{ nivel: 1, nombre: 'Aprendiz', puntos: 0 }];
  const titulos = [
    'Aprendiz', 'Caminante', 'Explorador', 'Conocedor', 'Experto Local',
    'Veterano', 'Maestro', 'Leyenda', 'Mito', 'Divino'
  ];
  
  for (let i = 2; i <= 100; i++) {
    const puntos = Math.floor(80 * Math.pow(i, 1.6));
    const tituloIdx = Math.min(Math.floor((i - 1) / 10), titulos.length - 1);
    niveles.push({ 
      nivel: i, 
      nombre: i === 100 ? '⭐ Dios de Tranqui' : `${titulos[tituloIdx]} Nv.${i}`, 
      puntos: puntos 
    });
  }
  return niveles;
}

const NIVELES = generarNiveles();

// =========================================================
// ⭐ 50 INSIGNIAS (Badges)
// =========================================================
const INSIGNIAS = {
  // --- EXPLORACIÓN (1-15) ---
  primer_paso: { nombre: 'Primer Paso', emoji: '🚶', categoria: 'exploracion', descripcion: 'Tu primer check-in en la Ruta Tranqui' },
  catador: { nombre: 'Catador', emoji: '☕', categoria: 'exploracion', descripcion: '5 cafeterías visitadas' },
  foodie: { nombre: 'Foodie', emoji: '🍔', categoria: 'exploracion', descripcion: '10 restaurantes visitados' },
  noctambulo: { nombre: 'Noctámbulo', emoji: '🌃', categoria: 'exploracion', descripcion: '3 bares después de las 8pm' },
  turista_local: { nombre: 'Turista Local', emoji: '🏘️', categoria: 'exploracion', descripcion: 'Visitas en 5 municipios distintos' },
  provincial: { nombre: 'Provincial', emoji: '🗺️', categoria: 'exploracion', descripcion: 'Visitas en 3 provincias distintas' },
  coleccionista: { nombre: 'Coleccionista', emoji: '🎯', categoria: 'exploracion', descripcion: '50 negocios únicos visitados' },
  centurion: { nombre: 'Centurión', emoji: '🌟', categoria: 'exploracion', descripcion: '100 negocios únicos visitados' },
  magnate: { nombre: 'Magnate', emoji: '👑', categoria: 'exploracion', descripcion: '200 negocios únicos visitados' },
  omnisciente: { nombre: 'Omnisciente', emoji: '👁️', categoria: 'exploracion', descripcion: '300 negocios únicos visitados' },
  barrio_x: { nombre: 'Barrio X', emoji: '📍', categoria: 'exploracion', descripcion: '10 check-ins en un mismo municipio' },
  isla_completa: { nombre: 'Isla Completa', emoji: '🇨🇺', categoria: 'exploracion', descripcion: 'Visitas en 10 provincias distintas' },
  madrugada: { nombre: 'Madrugada', emoji: '🦉', categoria: 'exploracion', descripcion: 'Check-in entre 12am y 5am' },
  fin_de_semana: { nombre: 'Fin de Semana', emoji: '🎉', categoria: 'exploracion', descripcion: 'Check-in un sábado o domingo' },
  viajero_frecuente: { nombre: 'Viajero Frecuente', emoji: '✈️', categoria: 'exploracion', descripcion: 'Check-ins en 50 municipios distintos' },

  // --- CONSTANCIA (16-25) ---
  racha_inicial: { nombre: 'Racha Inicial', emoji: '⚡', categoria: 'constancia', descripcion: 'Streak de 3 días consecutivos' },
  en_llamas: { nombre: 'En Llamas', emoji: '🔥', categoria: 'constancia', descripcion: 'Streak de 7 días consecutivos' },
  imparable: { nombre: 'Imparable', emoji: '💪', categoria: 'constancia', descripcion: 'Streak de 15 días consecutivos' },
  adicto_tranqui: { nombre: 'Adicto Tranqui', emoji: '🏅', categoria: 'constancia', descripcion: 'Streak de 30 días consecutivos' },
  leyenda_viva: { nombre: 'Leyenda Viva', emoji: '🐐', categoria: 'constancia', descripcion: 'Streak de 60 días consecutivos' },
  eterno: { nombre: 'Eterno', emoji: '♾️', categoria: 'constancia', descripcion: 'Streak de 100 días consecutivos' },
  madrugador: { nombre: 'Madrugador', emoji: '🌅', categoria: 'constancia', descripcion: 'Check-in antes de las 7am por 5 días' },
  nocturno: { nombre: 'Nocturno', emoji: '🌙', categoria: 'constancia', descripcion: 'Check-in después de las 10pm por 5 días' },
  semana_perfecta: { nombre: 'Semana Perfecta', emoji: '📅', categoria: 'constancia', descripcion: '7 check-ins en 7 días distintos' },
  mes_de_oro: { nombre: 'Mes de Oro', emoji: '🗓️', categoria: 'constancia', descripcion: '20 check-ins en un mismo mes' },

  // --- PUNTUACIÓN Y LOGROS (26-35) ---
  primer_100: { nombre: 'Primer 100', emoji: '💯', categoria: 'puntos', descripcion: 'Alcanza 100 puntos totales' },
  primer_500: { nombre: 'Primer 500', emoji: '🥈', categoria: 'puntos', descripcion: 'Alcanza 500 puntos totales' },
  primer_1000: { nombre: 'Primer 1000', emoji: '🥇', categoria: 'puntos', descripcion: 'Alcanza 1000 puntos totales' },
  primer_5000: { nombre: 'Primer 5000', emoji: '💎', categoria: 'puntos', descripcion: 'Alcanza 5000 puntos totales' },
  primer_10000: { nombre: 'Primer 10k', emoji: '🚀', categoria: 'puntos', descripcion: 'Alcanza 10,000 puntos totales' },
  primer_50000: { nombre: 'Primer 50k', emoji: '🌌', categoria: 'puntos', descripcion: 'Alcanza 50,000 puntos totales' },
  rico_en_puntos: { nombre: 'Rico en Puntos', emoji: '💰', categoria: 'puntos', descripcion: 'Gana 500 puntos en un solo mes' },
  golpe_de_suerte: { nombre: 'Golpe de Suerte', emoji: '🍀', categoria: 'puntos', descripcion: 'Gana 100 puntos en un solo check-in' },
  nivel_10: { nombre: 'Nivel 10', emoji: '🔟', categoria: 'puntos', descripcion: 'Alcanza el Nivel 10' },
  nivel_50: { nombre: 'Nivel 50', emoji: '🔱', categoria: 'puntos', descripcion: 'Alcanza el Nivel 50' },

  // --- ESPECIALES Y COMUNIDAD (36-50) ---
  campeon_mensual: { nombre: 'Campeón Mensual', emoji: '🏆', categoria: 'especial', descripcion: 'Fuiste #1 en el ranking mensual' },
  top_3_mensual: { nombre: 'Podio Mensual', emoji: '🥉', categoria: 'especial', descripcion: 'Quedaste en el Top 3 del ranking' },
  usuario_apklis: { nombre: 'Usuario Apklis', emoji: '🇨🇺', categoria: 'especial', descripcion: 'Te uniste a la Ruta Tranqui con Apklis' },
  creador: { nombre: 'Creador', emoji: '🏗️', categoria: 'especial', descripcion: 'Agregaste tu primer negocio al mapa' },
  contribuyente: { nombre: 'Contribuyente', emoji: '🤝', categoria: 'especial', descripcion: 'Agregaste 5 negocios al mapa' },
  mapamaster: { nombre: 'MapaMaster', emoji: '🗺️', categoria: 'especial', descripcion: 'Agregaste 20 negocios al mapa' },
  critico: { nombre: 'Crítico', emoji: '✍️', categoria: 'especial', descripcion: 'Dejaste 10 comentarios con puntuación' },
  sociable: { nombre: 'Sociable', emoji: '🗣️', categoria: 'especial', descripcion: 'Dejaste 50 comentarios' },
  verificador: { nombre: 'Verificador', emoji: '✅', categoria: 'especial', descripcion: 'Tus check-ins ayudaron a verificar un negocio' },
  vip_gold: { nombre: 'VIP Gold', emoji: '👑', categoria: 'especial', descripcion: 'Hiciste check-in en 10 negocios VIP Oro' },
  vip_silver: { nombre: 'VIP Silver', emoji: '🥈', categoria: 'especial', descripcion: 'Hiciste check-in en 10 negocios VIP Plata' },
  vip_bronze: { nombre: 'VIP Bronze', emoji: '🥉', categoria: 'especial', descripcion: 'Hiciste check-in en 10 negocios VIP Bronce' },
  descubridor: { nombre: 'Descubridor', emoji: '🔭', categoria: 'especial', descripcion: 'Fuiste el primer check-in en un negocio nuevo' },
  leal: { nombre: 'Leal', emoji: '❤️', categoria: 'especial', descripcion: '10 check-ins en el mismo negocio' },
  ultra_leal: { nombre: 'Ultra Leal', emoji: '💖', categoria: 'especial', descripcion: '30 check-ins en el mismo negocio' },
};

const LIMITE_NEGOCIOS_POR_DIA = 3;
const LIMITE_CHECKINS_POR_DIA = 10;
const COOLDOWN_NEGOCIO_HORAS = 24;
const RADIO_VALIDO_METROS = 50;
const CHECKINS_PARA_VERIFICAR = 3;

function obtenerTipoNegocioParaPuntos(negocioData) {
  if (negocioData.esVip && negocioData.tipoVip) {
    return negocioData.tipoVip.toLowerCase();
  }
  if (negocioData.verificado === true) {
    return 'verificado';
  }
  return 'normal';
}

function calcularPuntosCheckin(negocioData, streakActual) {
  const tipo = obtenerTipoNegocioParaPuntos(negocioData);
  let puntos = PUNTOS_POR_TIPO[tipo] || 10;

  if (streakActual >= 15) puntos += 10;
  else if (streakActual >= 7) puntos += 5;
  else if (streakActual >= 3) puntos += 2;

  return { puntos, tipo };
}

function calcularNivel(puntosTotales) {
  let nivelActual = NIVELES[0];
  for (const n of NIVELES) {
    if (puntosTotales >= n.puntos) {
      nivelActual = n;
    }
  }
  return nivelActual.nivel;
}

function obtenerMesActual() {
  const ahora = new Date();
  const anio = ahora.getFullYear();
  const mes = String(ahora.getMonth() + 1).padStart(2, '0');
  return `${anio}-${mes}`;
}

function obtenerDiaActual() {
  const ahora = new Date();
  const anio = ahora.getFullYear();
  const mes = String(ahora.getMonth() + 1).padStart(2, '0');
  const dia = String(ahora.getDate()).padStart(2, '0');
  return `${anio}-${mes}-${dia}`;
}

async function actualizarPerfilMes(perfilRef, perfilData) {
  const mesActual = obtenerMesActual();
  if (perfilData.mesActual !== mesActual) {
    await perfilRef.update({
      puntosMesActual: 0,
      mesActual: mesActual,
    });
    return { ...perfilData, puntosMesActual: 0, mesActual: mesActual };
  }
  return perfilData;
}

// ⭐ HELPER: Sumar puntos y recalcular nivel automáticamente
async function sumarPuntosYNivel(perfilRef, perfilData, puntos) {
  const nuevosPuntosTotales = (perfilData.puntosTotales || 0) + puntos;
  const nuevosPuntosMes = (perfilData.puntosMesActual || 0) + puntos;
  const nuevoNivel = calcularNivel(nuevosPuntosTotales);

  const datosActualizacion = {
    puntosTotales: nuevosPuntosTotales,
    puntosMesActual: nuevosPuntosMes,
  };

  if (nuevoNivel > (perfilData.nivel || 1)) {
    datosActualizacion.nivel = nuevoNivel;
  }

  await perfilRef.update(datosActualizacion);
  return { puntosTotales: nuevosPuntosTotales, nuevoNivel };
}

async function detectarInsignias(perfilRef, perfilData, checkins) {
  const insigniasActuales = perfilData.insignias || [];
  const nuevasInsignias = [];

  const totalCheckins = perfilData.totalCheckins || 0;
  const negociosVisitados = perfilData.negociosVisitados || 0;
  const streak = perfilData.streakActual || 0;
  const puntosTotales = perfilData.puntosTotales || 0;

  // --- EXPLORACIÓN ---
  if (totalCheckins >= 1 && !insigniasActuales.includes('primer_paso')) nuevasInsignias.push('primer_paso');
  if (negociosVisitados >= 50 && !insigniasActuales.includes('coleccionista')) nuevasInsignias.push('coleccionista');
  if (negociosVisitados >= 100 && !insigniasActuales.includes('centurion')) nuevasInsignias.push('centurion');
  if (negociosVisitados >= 200 && !insigniasActuales.includes('magnate')) nuevasInsignias.push('magnate');
  if (negociosVisitados >= 300 && !insigniasActuales.includes('omnisciente')) nuevasInsignias.push('omnisciente');

  // --- CONSTANCIA ---
  if (streak >= 3 && !insigniasActuales.includes('racha_inicial')) nuevasInsignias.push('racha_inicial');
  if (streak >= 7 && !insigniasActuales.includes('en_llamas')) nuevasInsignias.push('en_llamas');
  if (streak >= 15 && !insigniasActuales.includes('imparable')) nuevasInsignias.push('imparable');
  if (streak >= 30 && !insigniasActuales.includes('adicto_tranqui')) nuevasInsignias.push('adicto_tranqui');
  if (streak >= 60 && !insigniasActuales.includes('leyenda_viva')) nuevasInsignias.push('leyenda_viva');
  if (streak >= 100 && !insigniasActuales.includes('eterno')) nuevasInsignias.push('eterno');

  // --- PUNTUACIÓN ---
  if (puntosTotales >= 100 && !insigniasActuales.includes('primer_100')) nuevasInsignias.push('primer_100');
  if (puntosTotales >= 500 && !insigniasActuales.includes('primer_500')) nuevasInsignias.push('primer_500');
  if (puntosTotales >= 1000 && !insigniasActuales.includes('primer_1000')) nuevasInsignias.push('primer_1000');
  if (puntosTotales >= 5000 && !insigniasActuales.includes('primer_5000')) nuevasInsignias.push('primer_5000');
  if (puntosTotales >= 10000 && !insigniasActuales.includes('primer_10000')) nuevasInsignias.push('primer_10000');
  if (puntosTotales >= 50000 && !insigniasActuales.includes('primer_50000')) nuevasInsignias.push('primer_50000');

  // Calcular nivel actual para insignias de nivel
  let nivelActual = 1;
  for (const n of NIVELES) {
    if (puntosTotales >= n.puntos) nivelActual = n.nivel;
  }
  if (nivelActual >= 10 && !insigniasActuales.includes('nivel_10')) nuevasInsignias.push('nivel_10');
  if (nivelActual >= 50 && !insigniasActuales.includes('nivel_50')) nuevasInsignias.push('nivel_50');

  // --- Lógica avanzada de categorías (simplificada para no sobrecargar la DB) ---
  try {
    const categoriasVisitadas = {};
    const municipiosVisitados = new Set();
    const provinciasVisitadas = new Set();
    let baresNocturnos = 0;
    let cafeterias = 0;
    let restaurantes = 0;

    for (const checkin of checkins) {
      const negocioRef = db.collection('negocios').doc(checkin.negocioId);
      const negocioDoc = await negocioRef.get();
      if (!negocioDoc.exists) continue;
      const nd = negocioDoc.data();

      const cat = nd.categoriaPrincipal || 'otros';
      categoriasVisitadas[cat] = (categoriasVisitadas[cat] || 0) + 1;

      if (nd.municipio) municipiosVisitados.add(nd.municipio);
      if (nd.provincia) provinciasVisitadas.add(nd.provincia);

      if (cat === 'cafeteria') cafeterias++;
      if (cat === 'restaurante') restaurantes++;
      if (cat === 'bar') {
        const hora = checkin.timestamp.toDate().getHours();
        if (hora >= 20) baresNocturnos++;
      }
    }

    if (cafeterias >= 5 && !insigniasActuales.includes('catador')) nuevasInsignias.push('catador');
    if (restaurantes >= 10 && !insigniasActuales.includes('foodie')) nuevasInsignias.push('foodie');
    if (baresNocturnos >= 3 && !insigniasActuales.includes('noctambulo')) nuevasInsignias.push('noctambulo');
    if (municipiosVisitados.size >= 5 && !insigniasActuales.includes('turista_local')) nuevasInsignias.push('turista_local');
    if (provinciasVisitadas.size >= 3 && !insigniasActuales.includes('provincial')) nuevasInsignias.push('provincial');
  } catch (e) {
    console.error('⚠️ Error detectando insignias de categoría:', e.message);
  }

  if (nuevasInsignias.length > 0) {
    const todas = [...insigniasActuales, ...nuevasInsignias];
    await perfilRef.update({ insignias: todas });
  }

  return nuevasInsignias;
}

function calcularDistanciaMetros(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// --- INICIALIZAR EXPRESS ---
const app = express();
const port = process.env.PORT || 3000;

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json());

// ========== RUTAS PARA NEGOCIOS ==========

app.get('/api/negocios', async (req, res) => {
  console.log('📡 GET /api/negocios');
  try {
    const snapshot = await db.collection('negocios').orderBy('timestamp', 'desc').get();
    const negocios = [];
    
    const ahora = new Date();
    let contadorVip = 0;
    
    for (const doc of snapshot.docs) {
      const data = doc.data();
      
      // ⭐ AUTO-LIMPIEZA: Verificar estado VIP (solo alerta, no modifica)
      const esVipReal = await sincronizarEstadoVip(doc.id, data);
      
      if (esVipReal) {
        contadorVip++;
      }
      
      negocios.push({ 
        id: doc.id, 
        ...data,
        esVip: esVipReal
      });
    }
    
    negocios.sort((a, b) => {
      if (a.esVip && !b.esVip) return -1;
      if (!a.esVip && b.esVip) return 1;
      return 0;
    });
    
    console.log(`✅ Devolviendo ${negocios.length} negocios (${contadorVip} VIP vigentes)`);
    res.json({ success: true, data: negocios });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener negocios',
      error: error.message
    });
  }
});

app.post('/api/negocios', async (req, res) => {
  console.log('📡 POST /api/negocios');
  try {
    const {
      nombre,
      descripcion,
      latitud,
      longitud,
      provincia,
      municipio,
      categoriaPrincipal,
      categoriasSecundarias,
      agregadoPor,
    } = req.body;
    console.log('📝 Datos recibidos:', { nombre, provincia, municipio, categoriaPrincipal, agregadoPor });
    
    if (!nombre || nombre.trim() === '') {
      return res.status(400).json({ success: false, message: 'El nombre es obligatorio' });
    }
    if (latitud === undefined || longitud === undefined) {
      return res.status(400).json({ success: false, message: 'Faltan coordenadas' });
    }
    if (!provincia || provincia.trim() === '') {
      return res.status(400).json({ success: false, message: 'La provincia es obligatoria' });
    }
    if (!municipio || municipio.trim() === '') {
      return res.status(400).json({ success: false, message: 'El municipio es obligatorio' });
    }
    
    const validacion = validarCategorias(categoriaPrincipal, categoriasSecundarias);
    if (!validacion.valido) {
      return res.status(400).json({ success: false, message: validacion.error });
    }

    // ⭐ ANTI-FRAUDE RUTA TRANQUI: Límite de 3 negocios por día
    if (agregadoPor) {
      const perfilRef = db.collection('perfiles_usuarios').doc(agregadoPor);
      const perfilDoc = await perfilRef.get();
      
      if (perfilDoc.exists) {
        const perfilData = perfilDoc.data();
        const diaActual = obtenerDiaActual();
        
        if (perfilData.fechaUltimoNegocioAgregado) {
          const fechaUltimo = perfilData.fechaUltimoNegocioAgregado.toDate();
          const diaUltimo = `${fechaUltimo.getFullYear()}-${String(fechaUltimo.getMonth() + 1).padStart(2, '0')}-${String(fechaUltimo.getDate()).padStart(2, '0')}`;
          
          if (diaUltimo === diaActual && (perfilData.negociosAgregadosHoy || 0) >= LIMITE_NEGOCIOS_POR_DIA) {
            return res.status(403).json({
              success: false,
              message: `Alcanzaste el límite de ${LIMITE_NEGOCIOS_POR_DIA} negocios agregados por hoy. ¡Vuelve mañana!`,
            });
          }
        }
      }
    }
    
    const negocioData = {
      nombre: nombre.trim(),
      descripcion: descripcion ? descripcion.trim() : '',
      latitud: parseFloat(latitud),
      longitud: parseFloat(longitud),
      provincia: provincia.trim(),
      municipio: municipio.trim(),
      categoriaPrincipal: categoriaPrincipal,
      categoriasSecundarias: categoriasSecundarias || [],
      esVip: false,
      fotos: [],
      agregadoPor: agregadoPor || 'desconocido',
      verificado: false,
      checkinsUnicos: 0,
      totalCheckins: 0,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    };
    
    const docRef = await db.collection('negocios').add(negocioData);

    // ⭐ Actualizar contador y DAR PUNTOS por agregar negocio
    if (agregadoPor) {
      const perfilRef = db.collection('perfiles_usuarios').doc(agregadoPor);
      const perfilDoc = await perfilRef.get();
      const diaActual = obtenerDiaActual();
      
      if (perfilDoc.exists) {
        const perfilData = perfilDoc.data();
        const fechaUltimo = perfilData.fechaUltimoNegocioAgregado
          ? perfilData.fechaUltimoNegocioAgregado.toDate()
          : null;
        
        let nuevoContador = (perfilData.negociosAgregadosHoy || 0) + 1;
        if (fechaUltimo) {
          const diaUltimo = `${fechaUltimo.getFullYear()}-${String(fechaUltimo.getMonth() + 1).padStart(2, '0')}-${String(fechaUltimo.getDate()).padStart(2, '0')}`;
          if (diaUltimo !== diaActual) {
            nuevoContador = 1;
          }
        }
        
        // ⭐ Lógica de puntos: Máximo 2 negocios con puntos por día
        const dioPuntosHoy = perfilData.fechaUltimoNegocioConPuntos === diaActual;
        const conteoPuntos = dioPuntosHoy ? (perfilData.negociosConPuntosHoy || 0) : 0;

        if (conteoPuntos < 2) {
          await sumarPuntosYNivel(perfilRef, perfilData, 25);
          await perfilRef.update({
            fechaUltimoNegocioConPuntos: diaActual,
            negociosConPuntosHoy: conteoPuntos + 1
          });
        }

        await perfilRef.update({
          negociosAgregadosHoy: nuevoContador,
          fechaUltimoNegocioAgregado: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    }

    console.log(`✅ Negocio agregado con ID: ${docRef.id}`);
    res.status(201).json({
      success: true,
      message: 'Negocio agregado correctamente',
      id: docRef.id
    });
  } catch (error) {
    console.error('❌ Error al agregar negocio:', error);
    res.status(500).json({
      success: false,
      message: 'Error al agregar negocio',
      error: error.message
    });
  }
});

app.get('/api/negocios/:id', async (req, res) => {
  try {
    const doc = await db.collection('negocios').doc(req.params.id).get();
    if (!doc.exists) {
      return res.status(404).json({ success: false, message: 'Negocio no encontrado' });
    }
    
    const data = doc.data();
    
    // ⭐ AUTO-LIMPIEZA: Verificar estado VIP (solo alerta, no modifica)
    const esVipReal = await sincronizarEstadoVip(req.params.id, data);
    
    res.json({ 
      success: true, 
      data: { 
        id: doc.id, 
        ...data,
        esVip: esVipReal
      } 
    });
  } catch (error) {
    console.error('Error al obtener negocio:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener negocio',
      error: error.message
    });
  }
});

// ========== FOTOS DEL NEGOCIO (Cloudinary URLs) ==========

app.put('/api/negocios/:id/fotos', async (req, res) => {
  console.log(`📡 PUT /api/negocios/${req.params.id}/fotos`);
  try {
    const { username, fotos } = req.body;

    if (!username) {
      return res.status(400).json({ success: false, message: 'Falta campo: username' });
    }
    if (!Array.isArray(fotos)) {
      return res.status(400).json({ success: false, message: 'fotos debe ser un array' });
    }
    if (fotos.length > 30) {
      return res.status(400).json({ success: false, message: 'Máximo 30 fotos' });
    }

    const urlsInvalidas = fotos.filter(f => typeof f !== 'string' || !f.startsWith('https://'));
    if (urlsInvalidas.length > 0) {
      return res.status(400).json({ success: false, message: 'URLs de fotos inválidas (deben empezar con https://)' });
    }

    const negocioRef = db.collection('negocios').doc(req.params.id);
    const negocioDoc = await negocioRef.get();

    if (!negocioDoc.exists) {
      return res.status(404).json({ success: false, message: 'Negocio no encontrado' });
    }

    const negocioData = negocioDoc.data();
    const esAdminUser = esAdmin(username);
    const esPropietario = negocioData.propietarioUsername === username;

    if (!esAdminUser && !esPropietario) {
      return res.status(403).json({ success: false, message: 'No tienes permiso para modificar las fotos de este negocio' });
    }

    await negocioRef.update({
      fotos: fotos,
      timestampFotosUpdate: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`✅ Fotos actualizadas para ${req.params.id} por @${username}: ${fotos.length} foto(s)`);
    dispararGeneracionPaginas('fotos ' + req.params.id);
    res.json({ success: true, message: 'Fotos actualizadas correctamente' });
  } catch (error) {
    console.error('❌ Error al actualizar fotos:', error);
    res.status(500).json({
      success: false,
      message: 'Error al actualizar fotos',
      error: error.message
    });
  }
});

// ========== LICENCIAS APKLIS: ACTIVAR (fecha original + anti-downgrade) ==========

app.post('/api/licencias/activar', async (req, res) => {
  console.log('📡 POST /api/licencias/activar');
  try {
    const { licencia, tipoPlan, username } = req.body;

    if (!licencia || !tipoPlan) {
      return res.status(400).json({ success: false, message: 'Faltan campos: licencia, tipoPlan' });
    }

    const ahoraMs = Date.now();
    let licenciaVigente = null;

    const snapLicencias = await db
      .collection('licencias')
      .where('username', '==', username)
      .get();

    snapLicencias.forEach((d) => {
      const data = d.data();
      if (!data.fechaActivacion) return;
      const inicio = data.fechaActivacion.toDate().getTime();
      const fin = inicio + duracionDiasPlan(data.tipoPlan) * 86400000;
      if (fin > ahoraMs) {
        if (!licenciaVigente || rankPlan(data.tipoPlan) > rankPlan(licenciaVigente.tipoPlan)) {
          licenciaVigente = { id: d.id, ...data };
        }
      }
    });

    if (licenciaVigente && rankPlan(tipoPlan) < rankPlan(licenciaVigente.tipoPlan)) {
      console.log(`⛔ Downgrade bloqueado: @${username} tiene ${licenciaVigente.tipoPlan} vigente, intentó ${tipoPlan}`);
      return res.status(403).json({
        success: false,
        message: `No puedes bajar de plan. Tienes ${licenciaVigente.tipoPlan.toUpperCase()} vigente. Espera a que expire o elige un plan superior.`,
      });
    }

    const doc = await db.collection('licencias').doc(licencia).get();

    if (doc.exists) {
      const data = doc.data();
      const fechaActivacion = data.fechaActivacion ? data.fechaActivacion.toDate() : null;
      console.log(`🔁 Licencia ya activada: ${licencia.substring(0, 8)}... (original: ${fechaActivacion ? fechaActivacion.toISOString() : 'sin fecha'})`);
      return res.json({
        success: true,
        fechaActivacion: fechaActivacion ? fechaActivacion.toISOString() : null,
        tipoPlan: data.tipoPlan,
        yaExistia: true,
      });
    }

    const fechaActivacion = admin.firestore.Timestamp.now();
    await db.collection('licencias').doc(licencia).set({
      tipoPlan,
      username: username || 'desconocido',
      fechaActivacion,
      fechaCreacion: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`✅ Licencia activada por primera vez: ${licencia.substring(0, 8)}... (${tipoPlan})`);
    res.json({
      success: true,
      fechaActivacion: fechaActivacion.toDate().toISOString(),
      tipoPlan,
      yaExistia: false,
    });
  } catch (error) {
    console.error('❌ Error al activar licencia:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ========== ⭐ LICENCIA VIGENTE (fuente de verdad del plan) ==========

app.get('/api/licencias/vigente', async (req, res) => {
  try {
    const { username } = req.query;
    if (!username) {
      return res.status(400).json({ success: false, message: 'Falta username' });
    }

    const ahoraMs = Date.now();
    let licenciaVigente = null;

    const snapLicencias = await db
      .collection('licencias')
      .where('username', '==', username)
      .get();

    snapLicencias.forEach((d) => {
      const data = d.data();
      if (!data.fechaActivacion) return;
      const inicio = data.fechaActivacion.toDate().getTime();
      const fin = inicio + duracionDiasPlan(data.tipoPlan) * 86400000;
      if (fin > ahoraMs) {
        if (!licenciaVigente || rankPlan(data.tipoPlan) > rankPlan(licenciaVigente.tipoPlan)) {
          licenciaVigente = {
            id: d.id,
            licencia: d.id,
            tipoPlan: data.tipoPlan,
            fechaActivacion: data.fechaActivacion.toDate().toISOString(),
            fechaExpiracion: new Date(fin).toISOString(),
            diasRestantes: Math.ceil((fin - ahoraMs) / 86400000),
          };
        }
      }
    });

    if (!licenciaVigente) {
      return res.json({ success: true, vigente: false, data: null });
    }

    console.log(`✅ Licencia vigente de @${username}: ${licenciaVigente.tipoPlan} (${licenciaVigente.diasRestantes} días)`);
    res.json({ success: true, vigente: true, data: licenciaVigente });
  } catch (error) {
    console.error('❌ Error en /api/licencias/vigente:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ========== RUTAS PARA CATEGORÍAS ==========

app.get('/api/categorias', async (req, res) => {
  console.log('📡 GET /api/categorias');
  try {
    const snapshot = await db
      .collection('categorias')
      .where('activo', '==', true)
      .orderBy('orden', 'asc')
      .get();

    const categorias = [];
    snapshot.forEach(doc => {
      categorias.push({ id: doc.id, ...doc.data() });
    });

    console.log(`✅ Devolviendo ${categorias.length} categorías`);
    res.json({ success: true, data: categorias });
  } catch (error) {
    console.error('❌ Error al obtener categorías:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener categorías',
      error: error.message
    });
  }
});

app.post('/api/admin/poblar-categorias', async (req, res) => {
  const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'TRANQUI_ADMIN_2026';
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN) {
    return res.status(403).json({ success: false, message: 'Sin autorización' });
  }

  try {
    const categoriasDefinicion = [
      { id: 'restaurante', nombre: 'Restaurante/Paladar', grupo: 'comida', orden: 1 },
      { id: 'cafeteria', nombre: 'Cafetería/Pizzería', grupo: 'comida', orden: 2 },
      { id: 'bar', nombre: 'Bar/Centro Nocturno', grupo: 'comida', orden: 3 },
      { id: 'reposteria', nombre: 'Dulcería/Heladería', grupo: 'comida', orden: 4 },
      { id: 'elaborador_alimentos', nombre: 'Elaborador de Alimentos', grupo: 'comida', orden: 5 },
      { id: 'mercado', nombre: 'Mercado/Bodega/Tienda', grupo: 'compras', orden: 1 },
      { id: 'ropa_calzado', nombre: 'Tienda de Ropa y calzado', grupo: 'compras', orden: 2 },
      { id: 'ferreteria', nombre: 'Ferretería y Construcción', grupo: 'compras', orden: 3 },
      { id: 'farmacia', nombre: 'Farmacia/Óptica', grupo: 'compras', orden: 4 },
      { id: 'electronica', nombre: 'Tienda de Celulares y Electrónica', grupo: 'compras', orden: 5 },
      { id: 'papeleria', nombre: 'Librería', grupo: 'compras', orden: 6 },
      { id: 'peluqueria', nombre: 'Peluquería / Barbería', grupo: 'belleza', orden: 1 },
      { id: 'salon_belleza', nombre: 'Salón de belleza / Uñas / Spa', grupo: 'belleza', orden: 2 },
      { id: 'tatuajes', nombre: 'Tatuajes / Piercings', grupo: 'belleza', orden: 3 },
      { id: 'taller_electronica', nombre: 'Electrónica/Celulares', grupo: 'talleres', orden: 1 },
      { id: 'taller_mecanico', nombre: 'Mecánico/Chapista', grupo: 'talleres', orden: 2 },
      { id: 'costura', nombre: 'Costura/Zapatería/Cerrajería', grupo: 'talleres', orden: 3 },
      { id: 'sala_juegos', nombre: 'Sala de Juegos/ Cine 3D', grupo: 'ocio', orden: 1 },
      { id: 'billar', nombre: 'Billar/Bolos', grupo: 'ocio', orden: 2 },
      { id: 'piscina', nombre: 'Piscina', grupo: 'ocio', orden: 3 },
      { id: 'eventos', nombre: 'Eventos/Fiestas', grupo: 'ocio', orden: 4 },
      { id: 'consulta_medica', nombre: 'Clinica/Dentista', grupo: 'salud', orden: 1 },
      { id: 'veterinaria', nombre: 'Veterinaria', grupo: 'salud', orden: 2 },
      { id: 'taxi', nombre: 'Taxi', grupo: 'transporte', orden: 1 },
      { id: 'transporte_provincial', nombre: 'Transporte Interprovincial', grupo: 'transporte', orden: 2 },
      { id: 'alquiler_vehiculos', nombre: 'Alquiler de Vehículos', grupo: 'transporte', orden: 3 },
      { id: 'fotografia', nombre: 'Fotografía/Diseño/Audiovisuales', grupo: 'servicios', orden: 1 },
      { id: 'gestoria', nombre: 'Gestor/Contador', grupo: 'servicios', orden: 2 },
      { id: 'tutorias', nombre: 'Tutorías/Academia', grupo: 'servicios', orden: 3 },
      { id: 'recargas', nombre: 'Recargas/Transfermóvil', grupo: 'servicios', orden: 4 },
      { id: 'otros', nombre: 'Otros servicios', grupo: 'otros', orden: 99 },
    ];

    const batch = db.batch();
    categoriasDefinicion.forEach(cat => {
      const ref = db.collection('categorias').doc(cat.id);
      batch.set(ref, { ...cat, activo: true }, { merge: true });
    });

    const categoriasObsoletas = [
      'comida_rapida',
      'supermercado',
      'reparacion_celulares',
      'cibercafe',
    ];

    for (const id of categoriasObsoletas) {
      const ref = db.collection('categorias').doc(id);
      const doc = await ref.get();
      if (doc.exists) {
        batch.set(ref, { activo: false }, { merge: true });
        console.log(`🗑️ Categoría obsoleta desactivada: ${id}`);
      }
    }

    await batch.commit();

    console.log(`✅ ${categoriasDefinicion.length} categorías pobladas en Firestore`);
    res.json({
      success: true,
      message: `${categoriasDefinicion.length} categorías pobladas correctamente, ${categoriasObsoletas.length} obsoletas desactivadas`,
      categorias: categoriasDefinicion.map(c => c.id),
      obsoletas: categoriasObsoletas
    });
  } catch (error) {
    console.error('❌ Error al poblar categorías:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ========== RUTAS PARA GESTIÓN VIP ==========

app.put('/api/negocios/:id/reclamar', async (req, res) => {
  console.log(`📡 PUT /api/negocios/${req.params.id}/reclamar`);
  try {
    const { username, tipoVip, vipHasta } = req.body;
    
    if (!username || !tipoVip || !vipHasta) {
      return res.status(400).json({ success: false, message: 'Faltan campos: username, tipoVip, vipHasta' });
    }

    const negocioRef = db.collection('negocios').doc(req.params.id);
    const negocioDoc = await negocioRef.get();

    if (!negocioDoc.exists) {
      return res.status(404).json({ success: false, message: 'Negocio no encontrado' });
    }

    const negocioData = negocioDoc.data();

    if (negocioData.esVip && negocioData.propietarioUsername && negocioData.propietarioUsername !== username) {
      const vipHastaActual = negocioData.vipHasta?.toDate();
      const ahora = new Date();
      
      if (vipHastaActual && vipHastaActual > ahora) {
        return res.status(409).json({ success: false, message: `Este negocio ya fue reclamado por @${negocioData.propietarioUsername}` });
      }
    }

    const snapshot = await db.collection('negocios')
      .where('propietarioUsername', '==', username)
      .where('esVip', '==', true)
      .get();

    const ahora = new Date();
    let negociosVigentes = 0;
    const idsVigentes = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.vipHasta) {
        const vipHasta = data.vipHasta.toDate();
        if (vipHasta > ahora) {
          negociosVigentes++;
          idsVigentes.push(doc.id);
        }
      }
    });

    const t = tipoVip.toLowerCase();
    let limite = 1;
    if (t.includes('oro')) limite = 5;
    else if (t.includes('plata')) limite = 3;
    else if (t.includes('bronce')) limite = 1;
    else if (t.includes('prueba')) limite = 1;

    const esMismoNegocio = idsVigentes.includes(req.params.id);
    
    if (!esMismoNegocio && negociosVigentes >= limite) {
      return res.status(403).json({ success: false, message: `Has alcanzado el límite de ${limite} negocio(s) para el plan ${tipoVip}. Contacta al administrador.` });
    }

    await negocioRef.update({
      esVip: true,
      tipoVip: tipoVip.toLowerCase(),
      propietarioUsername: username,
      vipHasta: admin.firestore.Timestamp.fromDate(new Date(vipHasta)),
      timestampVip: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`✅ Negocio ${req.params.id} reclamado por @${username} (Plan: ${tipoVip})`);
    dispararGeneracionPaginas('reclamo ' + req.params.id);
    res.json({
      success: true,
      message: 'Negocio reclamado correctamente',
      negociosVigentes: esMismoNegocio ? negociosVigentes : negociosVigentes + 1,
      limite: limite
    });
  } catch (error) {
    console.error('❌ Error al reclamar negocio:', error);
    res.status(500).json({
      success: false,
      message: 'Error al reclamar negocio',
      error: error.message
    });
  }
});

app.put('/api/negocios/:id/vip', async (req, res) => {
  console.log(`📡 PUT /api/negocios/${req.params.id}/vip`);
  try {
    const {
      username,
      descripcionVip,
      telefono,
      whatsapp,
      horario,
      nombre,
      descripcion,
      categoriaPrincipal,
      categoriasSecundarias,
    } = req.body;

    if (!username) {
      return res.status(400).json({ success: false, message: 'Falta campo: username' });
    }

    const negocioRef = db.collection('negocios').doc(req.params.id);
    const negocioDoc = await negocioRef.get();

    if (!negocioDoc.exists) {
      return res.status(404).json({ success: false, message: 'Negocio no encontrado' });
    }

    const negocioData = negocioDoc.data();

    if (negocioData.propietarioUsername !== username) {
      return res.status(403).json({ success: false, message: 'No tienes permiso para editar este negocio' });
    }

    if (!negocioData.esVip || !negocioData.vipHasta) {
      return res.status(403).json({ success: false, message: 'Este negocio no es VIP' });
    }

    const vipHasta = negocioData.vipHasta.toDate();
    if (vipHasta <= new Date()) {
      return res.status(403).json({ success: false, message: 'La licencia VIP ha expirado. Contacta al administrador para renovarla.' });
    }

    if (categoriaPrincipal !== undefined) {
      const validacion = validarCategorias(categoriaPrincipal, categoriasSecundarias);
      if (!validacion.valido) {
        return res.status(400).json({ success: false, message: validacion.error });
      }
    }

    const updateData = {
      timestampActualizacion: admin.firestore.FieldValue.serverTimestamp()
    };

    if (descripcionVip !== undefined) updateData.descripcionVip = descripcionVip;
    if (telefono !== undefined) updateData.telefono = telefono;
    if (whatsapp !== undefined) updateData.whatsapp = whatsapp;
    if (horario !== undefined) updateData.horario = horario;
    if (nombre !== undefined) updateData.nombre = nombre;
    if (descripcion !== undefined) updateData.descripcion = descripcion;
    if (categoriaPrincipal !== undefined) updateData.categoriaPrincipal = categoriaPrincipal;
    if (categoriasSecundarias !== undefined) updateData.categoriasSecundarias = categoriasSecundarias;

    await negocioRef.update(updateData);

    console.log(`✅ Negocio ${req.params.id} actualizado por @${username}`);
    dispararGeneracionPaginas('vip-edit ' + req.params.id);
    res.json({ success: true, message: 'Negocio actualizado correctamente' });
  } catch (error) {
    console.error('❌ Error al actualizar negocio:', error);
    res.status(500).json({
      success: false,
      message: 'Error al actualizar negocio',
      error: error.message
    });
  }
});

// ========== RUTAS DE ADMIN ==========

app.put('/api/admin/negocios/:id', async (req, res) => {
  console.log(`📡 PUT /api/admin/negocios/${req.params.id}`);
  try {
    const {
      adminUsername,
      nombre,
      descripcion,
      descripcionVip,
      telefono,
      whatsapp,
      horario,
      categoriaPrincipal,
      categoriasSecundarias,
      provincia,
      municipio,
      latitud,
      longitud,
    } = req.body;

    if (!adminUsername) {
      return res.status(400).json({ success: false, message: 'Falta campo: adminUsername' });
    }
    if (!esAdmin(adminUsername)) {
      console.log(`⛔ Acceso admin denegado a: @${adminUsername}`);
      return res.status(403).json({ success: false, message: 'No tienes permisos de administrador' });
    }

    const negocioRef = db.collection('negocios').doc(req.params.id);
    const negocioDoc = await negocioRef.get();

    if (!negocioDoc.exists) {
      return res.status(404).json({ success: false, message: 'Negocio no encontrado' });
    }

    if (categoriaPrincipal !== undefined) {
      const validacion = validarCategorias(categoriaPrincipal, categoriasSecundarias);
      if (!validacion.valido) {
        return res.status(400).json({ success: false, message: validacion.error });
      }
    }

    const updateData = {
      timestampAdminUpdate: admin.firestore.FieldValue.serverTimestamp(),
      adminQueModifico: adminUsername,
    };

    if (nombre !== undefined) updateData.nombre = nombre;
    if (descripcion !== undefined) updateData.descripcion = descripcion;
    if (descripcionVip !== undefined) updateData.descripcionVip = descripcionVip;
    if (telefono !== undefined) updateData.telefono = telefono;
    if (whatsapp !== undefined) updateData.whatsapp = whatsapp;
    if (horario !== undefined) updateData.horario = horario;
    if (categoriaPrincipal !== undefined) updateData.categoriaPrincipal = categoriaPrincipal;
    if (categoriasSecundarias !== undefined) updateData.categoriasSecundarias = categoriasSecundarias;
    if (provincia !== undefined) updateData.provincia = provincia;
    if (municipio !== undefined) updateData.municipio = municipio;
    if (latitud !== undefined) updateData.latitud = parseFloat(latitud);
    if (longitud !== undefined) updateData.longitud = parseFloat(longitud);

    await negocioRef.update(updateData);

    console.log(`✅ [ADMIN] Negocio ${req.params.id} editado por @${adminUsername}`);
    dispararGeneracionPaginas('admin-edit ' + req.params.id);
    res.json({ success: true, message: 'Negocio actualizado por administrador' });
  } catch (error) {
    console.error('❌ Error admin al actualizar:', error);
    res.status(500).json({
      success: false,
      message: 'Error al actualizar negocio',
      error: error.message,
    });
  }
});

app.delete('/api/admin/negocios/:id', async (req, res) => {
  console.log(`📡 DELETE /api/admin/negocios/${req.params.id}`);
  try {
    const { adminUsername } = req.body;

    if (!adminUsername) {
      return res.status(400).json({ success: false, message: 'Falta campo: adminUsername' });
    }
    if (!esAdmin(adminUsername)) {
      return res.status(403).json({ success: false, message: 'No tienes permisos de administrador' });
    }

    const negocioRef = db.collection('negocios').doc(req.params.id);
    const negocioDoc = await negocioRef.get();

    if (!negocioDoc.exists) {
      return res.status(404).json({ success: false, message: 'Negocio no encontrado' });
    }

    const comentariosRef = negocioRef.collection('comentarios');
    const comentariosSnap = await comentariosRef.get();
    const batch = db.batch();
    comentariosSnap.forEach(doc => batch.delete(doc.ref));
    
    const catalogoRef = negocioRef.collection('catalogo');
    const catalogoSnap = await catalogoRef.get();
    catalogoSnap.forEach(doc => batch.delete(doc.ref));
    
    batch.delete(negocioRef);
    await batch.commit();

    console.log(`✅ [ADMIN] Negocio ${req.params.id} borrado permanentemente por @${adminUsername}`);
    dispararGeneracionPaginas('borrado ' + req.params.id);
    res.json({ success: true, message: 'Negocio eliminado correctamente' });
  } catch (error) {
    console.error('❌ Error admin al borrar:', error);
    res.status(500).json({
      success: false,
      message: 'Error al borrar negocio',
      error: error.message,
    });
  }
});

app.get('/api/admin/stats', async (req, res) => {
  try {
    const { adminUsername } = req.query;
    if (!esAdmin(adminUsername)) {
      return res.status(403).json({ success: false, message: 'No autorizado' });
    }

    const negociosSnap = await db.collection('negocios').get();
    const totalNegocios = negociosSnap.size;

    const ahora = new Date();
    let vipVigentes = 0;
    let pruebas = 0;
    const porCategoria = {};
    const porPlan = {};

    for (const doc of negociosSnap.docs) {
      const data = doc.data();

      if (data.esNegocioPrueba === true) pruebas++;

      // ⭐ AUTO-LIMPIEZA en stats (solo alerta, no modifica)
      const esVipReal = await sincronizarEstadoVip(doc.id, data);
      
      if (esVipReal) {
        vipVigentes++;
        const plan = data.tipoVip || 'desconocido';
        porPlan[plan] = (porPlan[plan] || 0) + 1;
      }

      const cat = data.categoriaPrincipal || 'sin_categoria';
      porCategoria[cat] = (porCategoria[cat] || 0) + 1;
    }

    res.json({
      success: true,
      data: {
        totalNegocios,
        vipVigentes,
        pruebas,
        porCategoria,
        porPlan,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('❌ Error en stats:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/admin/negocios/:id/vip-status', async (req, res) => {
  console.log(`📡 PUT /api/admin/negocios/${req.params.id}/vip-status`);
  try {
    const {
      adminUsername,
      accion,
      tipoVip,
      propietarioUsername,
      vipHasta,
      esNegocioPrueba,
    } = req.body;

    if (!adminUsername) {
      return res.status(400).json({ success: false, message: 'Falta campo: adminUsername' });
    }
    if (!esAdmin(adminUsername)) {
      return res.status(403).json({ success: false, message: 'No tienes permisos de administrador' });
    }

    const negocioRef = db.collection('negocios').doc(req.params.id);
    const negocioDoc = await negocioRef.get();

    if (!negocioDoc.exists) {
      return res.status(404).json({ success: false, message: 'Negocio no encontrado' });
    }

    let updateData = {
      timestampAdminVipUpdate: admin.firestore.FieldValue.serverTimestamp(),
      adminQueModificoVip: adminUsername,
    };

    if (accion === 'reclamar') {
      if (!tipoVip || !vipHasta) {
        return res.status(400).json({ success: false, message: 'Para reclamar se requiere: tipoVip, vipHasta' });
      }
      
      let propietarioFinal = propietarioUsername || adminUsername;
      let esPrueba = false;
      
      if (esNegocioPrueba === true) {
        propietarioFinal = `${adminUsername}_usuario_test`;
        esPrueba = true;
      }
      
      updateData = {
        ...updateData,
        esVip: true,
        tipoVip: tipoVip.toLowerCase(),
        propietarioUsername: propietarioFinal,
        vipHasta: admin.firestore.Timestamp.fromDate(new Date(vipHasta)),
        esNegocioPrueba: esPrueba,
        creadoPorAdmin: esPrueba ? adminUsername : null,
        fotos: [],
      };
    } else if (accion === 'liberar') {
      updateData = {
        ...updateData,
        esVip: false,
        tipoVip: null,
        propietarioUsername: null,
        vipHasta: null,
        descripcionVip: null,
        esNegocioPrueba: false,
        creadoPorAdmin: null,
        fotos: [],
      };
    } else if (accion === 'extender') {
      if (!vipHasta) {
        return res.status(400).json({ success: false, message: 'Para extender se requiere: vipHasta' });
      }
      updateData = {
        ...updateData,
        vipHasta: admin.firestore.Timestamp.fromDate(new Date(vipHasta)),
      };
    } else if (accion === 'cambiar-tipo') {
      if (!tipoVip) {
        return res.status(400).json({ success: false, message: 'Para cambiar tipo se requiere: tipoVip' });
      }
      
      const negocioActual = negocioDoc.data();
      if (!negocioActual.esVip) {
        return res.status(400).json({ success: false, message: 'El negocio no es VIP actualmente' });
      }
      
      updateData = {
        ...updateData,
        tipoVip: tipoVip.toLowerCase(),
      };
    } else {
      return res.status(400).json({ success: false, message: 'Acción inválida. Usa: reclamar, liberar, extender, o cambiar-tipo' });
    }

    await negocioRef.update(updateData);

    console.log(`✅ [ADMIN] VIP status cambiado por @${adminUsername} (${accion})`);
    if (accion === 'reclamar' || accion === 'liberar') {
      dispararGeneracionPaginas('admin ' + accion + ' ' + req.params.id);
    }
    res.json({ success: true, message: `Estado VIP actualizado (${accion})` });
  } catch (error) {
    console.error('❌ Error admin al cambiar VIP status:', error);
    res.status(500).json({
      success: false,
      message: 'Error al cambiar estado VIP',
      error: error.message,
    });
  }
});

app.get('/api/admin/verificar', async (req, res) => {
  try {
    const { username } = req.query;
    if (!username) {
      return res.status(400).json({ success: false, message: 'Falta username' });
    }
    res.json({ success: true, esAdmin: esAdmin(username) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ========== CATÁLOGO DE NEGOCIOS VIP ==========

app.get('/api/negocios/:negocioId/catalogo', async (req, res) => {
  console.log(`📡 GET /api/negocios/${req.params.negocioId}/catalogo`);
  try {
    const snapshot = await db
      .collection('negocios')
      .doc(req.params.negocioId)
      .collection('catalogo')
      .where('activo', '==', true)
      .get();

    const productos = [];
    snapshot.forEach(doc => {
      productos.push({ id: doc.id, ...doc.data() });
    });

    productos.sort((a, b) => (a.orden || 0) - (b.orden || 0));

    console.log(`✅ Catálogo ${req.params.negocioId}: ${productos.length} productos`);
    res.json({ success: true, data: productos });
  } catch (error) {
    console.error('❌ Error al obtener catálogo:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener catálogo',
      error: error.message
    });
  }
});

app.get('/api/negocios/:negocioId/catalogo/agrupado', async (req, res) => {
  console.log(`📡 GET /api/negocios/${req.params.negocioId}/catalogo/agrupado`);
  try {
    const snapshot = await db
      .collection('negocios')
      .doc(req.params.negocioId)
      .collection('catalogo')
      .where('activo', '==', true)
      .get();

    const productosPorCategoria = {};
    snapshot.forEach(doc => {
      const data = doc.data();
      const categoria = data.categoria || 'General';
      if (!productosPorCategoria[categoria]) {
        productosPorCategoria[categoria] = [];
      }
      productosPorCategoria[categoria].push({ id: doc.id, ...data });
    });

    for (const cat in productosPorCategoria) {
      productosPorCategoria[cat].sort((a, b) => (a.orden || 0) - (b.orden || 0));
    }

    console.log(`✅ Catálogo agrupado ${req.params.negocioId}: ${Object.keys(productosPorCategoria).length} categorías`);
    res.json({ success: true, data: productosPorCategoria });
  } catch (error) {
    console.error('❌ Error al obtener catálogo agrupado:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener catálogo',
      error: error.message
    });
  }
});

app.post('/api/negocios/:negocioId/catalogo', async (req, res) => {
  console.log(`📡 POST /api/negocios/${req.params.negocioId}/catalogo`);
  try {
    const {
      adminUsername,
      propietarioUsername,
      nombre,
      descripcion,
      precio,
      moneda,
      categoria,
      imagenUrl,
      orden,
      agotado,
    } = req.body;

    const negocioRef = db.collection('negocios').doc(req.params.negocioId);
    const negocioDoc = await negocioRef.get();

    if (!negocioDoc.exists) {
      return res.status(404).json({ success: false, message: 'Negocio no encontrado' });
    }

    const negocioData = negocioDoc.data();
    const esAdminUser = esAdmin(adminUsername);
    const esPropietario = negocioData.propietarioUsername === propietarioUsername;

    if (!esAdminUser && !esPropietario) {
      return res.status(403).json({ success: false, message: 'Sin permisos para agregar productos' });
    }

    if (!esAdminUser && !negocioData.esVip) {
      return res.status(403).json({ success: false, message: 'Tu licencia VIP ha expirado. Contacta al administrador para renovarla.' });
    }

    if (!nombre || nombre.trim() === '') {
      return res.status(400).json({ success: false, message: 'El nombre del producto es obligatorio' });
    }

    const productoData = {
      nombre: nombre.trim(),
      descripcion: descripcion ? descripcion.trim() : '',
      precio: precio ? parseFloat(precio) : 0,
      moneda: moneda || 'CUP',
      categoria: categoria || 'General',
      imagenUrl: imagenUrl || '',
      orden: orden || 0,
      activo: true,
      agotado: agotado === true,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await negocioRef.collection('catalogo').add(productoData);
    
    console.log(`✅ Producto agregado al catálogo de ${req.params.negocioId}: ${docRef.id} (${nombre})`);
    dispararGeneracionPaginas('catalogo ' + req.params.negocioId);
    res.status(201).json({
      success: true,
      message: 'Producto agregado correctamente',
      id: docRef.id
    });
  } catch (error) {
    console.error('❌ Error al agregar producto:', error);
    res.status(500).json({
      success: false,
      message: 'Error al agregar producto',
      error: error.message
    });
  }
});

app.put('/api/negocios/:negocioId/catalogo/:productoId', async (req, res) => {
  console.log(`📡 PUT /api/negocios/${req.params.negocioId}/catalogo/${req.params.productoId}`);
  try {
    const {
      adminUsername,
      propietarioUsername,
      nombre,
      descripcion,
      precio,
      moneda,
      categoria,
      imagenUrl,
      orden,
      activo,
      agotado,
    } = req.body;

    const negocioRef = db.collection('negocios').doc(req.params.negocioId);
    const negocioDoc = await negocioRef.get();

    if (!negocioDoc.exists) {
      return res.status(404).json({ success: false, message: 'Negocio no encontrado' });
    }

    const negocioData = negocioDoc.data();
    const esAdminUser = esAdmin(adminUsername);
    const esPropietario = negocioData.propietarioUsername === propietarioUsername;

    if (!esAdminUser && !esPropietario) {
      return res.status(403).json({ success: false, message: 'Sin permisos para editar productos' });
    }

    const productoRef = negocioRef.collection('catalogo').doc(req.params.productoId);
    const productoDoc = await productoRef.get();

    if (!productoDoc.exists) {
      return res.status(404).json({ success: false, message: 'Producto no encontrado' });
    }

    const updateData = {
      timestampActualizacion: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (nombre !== undefined) updateData.nombre = nombre.trim();
    if (descripcion !== undefined) updateData.descripcion = descripcion.trim();
    if (precio !== undefined) updateData.precio = parseFloat(precio);
    if (moneda !== undefined) updateData.moneda = moneda;
    if (categoria !== undefined) updateData.categoria = categoria;
    if (imagenUrl !== undefined) updateData.imagenUrl = imagenUrl;
    if (orden !== undefined) updateData.orden = orden;
    if (activo !== undefined) updateData.activo = activo;
    if (agotado !== undefined) updateData.agotado = agotado;

    await productoRef.update(updateData);

    console.log(`✅ Producto ${req.params.productoId} actualizado`);
    dispararGeneracionPaginas('catalogo update ' + req.params.negocioId);
    res.json({ success: true, message: 'Producto actualizado correctamente' });
  } catch (error) {
    console.error('❌ Error al actualizar producto:', error);
    res.status(500).json({
      success: false,
      message: 'Error al actualizar producto',
      error: error.message
    });
  }
});

app.delete('/api/negocios/:negocioId/catalogo/:productoId', async (req, res) => {
  console.log(`📡 DELETE /api/negocios/${req.params.negocioId}/catalogo/${req.params.productoId}`);
  try {
    const { adminUsername, propietarioUsername } = req.body;

    const negocioRef = db.collection('negocios').doc(req.params.negocioId);
    const negocioDoc = await negocioRef.get();

    if (!negocioDoc.exists) {
      return res.status(404).json({ success: false, message: 'Negocio no encontrado' });
    }

    const negocioData = negocioDoc.data();
    const esAdminUser = esAdmin(adminUsername);
    const esPropietario = negocioData.propietarioUsername === propietarioUsername;

    if (!esAdminUser && !esPropietario) {
      return res.status(403).json({ success: false, message: 'Sin permisos para eliminar productos' });
    }

    const productoRef = negocioRef.collection('catalogo').doc(req.params.productoId);
    const productoDoc = await productoRef.get();

    if (!productoDoc.exists) {
      return res.status(404).json({ success: false, message: 'Producto no encontrado' });
    }

    await productoRef.update({
      activo: false,
      timestampEliminacion: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`✅ Producto ${req.params.productoId} eliminado (soft delete)`);
    dispararGeneracionPaginas('catalogo delete ' + req.params.negocioId);
    res.json({ success: true, message: 'Producto eliminado correctamente' });
  } catch (error) {
    console.error('❌ Error al eliminar producto:', error);
    res.status(500).json({
      success: false,
      message: 'Error al eliminar producto',
      error: error.message
    });
  }
});

// ========== RUTAS PARA COMENTARIOS ==========

app.get('/api/comentarios/:negocioId', async (req, res) => {
  console.log(`📡 GET /api/comentarios/${req.params.negocioId}`);
  try {
    const snapshot = await db
      .collection('negocios')
      .doc(req.params.negocioId)
      .collection('comentarios')
      .orderBy('timestamp', 'desc')
      .get();

    const comentarios = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      comentarios.push({
        id: doc.id,
        texto: data.texto || '',
        autor: data.autor || 'Anónimo',
        timestamp: data.timestamp || null,
        puntuacion: data.puntuacion || null,
      });
    });

    console.log(`✅ Devolviendo ${comentarios.length} comentarios`);
    res.json({ success: true, data: comentarios });
  } catch (error) {
    console.error('❌ Error al obtener comentarios:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener comentarios',
      error: error.message
    });
  }
});

app.post('/api/comentarios/:negocioId', async (req, res) => {
  console.log(`📡 POST /api/comentarios/${req.params.negocioId}`);
  try {
    const { texto, autor, puntuacion, username } = req.body;

    if (!texto || texto.trim().length === 0) {
      return res.status(400).json({ success: false, message: 'El texto del comentario no puede estar vacío.' });
    }

    const negocioRef = db.collection('negocios').doc(req.params.negocioId);
    const negocioDoc = await negocioRef.get();
    
    if (!negocioDoc.exists) {
        return res.status(404).json({ success: false, message: 'Negocio no encontrado' });
    }
    
    const negocioData = negocioDoc.data();
    if (username && negocioData.propietarioUsername === username) {
      return res.status(403).json({ success: false, message: 'No puedes reseñar tu propio negocio.' });
    }

    const comentarioData = {
      texto: texto.trim(),
      autor: autor?.trim() || 'Anónimo',
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      puntuacion: puntuacion || null,
    };

    const docRef = await db
      .collection('negocios')
      .doc(req.params.negocioId)
      .collection('comentarios')
      .add(comentarioData);

    if (negocioData) {
      const totalComentarios = (negocioData.totalComentarios || 0) + 1;
      const totalPuntuaciones = (negocioData.totalPuntuaciones || 0) + (puntuacion ? 1 : 0);
      const sumaPuntuaciones = (negocioData.sumaPuntuaciones || 0) + (puntuacion || 0);
      const promedioPuntuacion = totalPuntuaciones > 0 ? sumaPuntuaciones / totalPuntuaciones : null;

      await negocioRef.update({
        totalComentarios: totalComentarios,
        totalPuntuaciones: totalPuntuaciones,
        sumaPuntuaciones: sumaPuntuaciones,
        promedioPuntuacion: promedioPuntuacion,
      });
    }

    if (username && texto.trim().length >= 15) {
      const perfilRef = db.collection('perfiles_usuarios').doc(username);
      const perfilDoc = await perfilRef.get();
      
      if (perfilDoc.exists) {
        const perfilData = perfilDoc.data();
        const hoy = obtenerDiaActual();
        const dioPuntosHoy = perfilData.fechaUltimaResenaConPuntos === hoy;
        const conteo = dioPuntosHoy ? (perfilData.resenasConPuntosHoy || 0) : 0;

        if (conteo < 3) {
          await sumarPuntosYNivel(perfilRef, perfilData, 15);
          await perfilRef.update({
            fechaUltimaResenaConPuntos: hoy,
            resenasConPuntosHoy: conteo + 1
          });
          console.log(`✅ @${username} ganó 15 puntos por reseñar (comentario >= 15 chars).`);
        } else {
          console.log(`⚠️ @${username} alcanzó el límite diario de puntos por reseñas.`);
        }
      }
    } else if (username) {
        console.log(`⚠️ @${username} comentó, pero no ganó puntos (menos de 15 caracteres).`);
    }

    console.log(`✅ Comentario agregado con ID: ${docRef.id}`);
    res.status(201).json({
      success: true,
      message: 'Comentario agregado correctamente',
      id: docRef.id
    });
  } catch (error) {
    console.error('❌ Error al agregar comentario:', error);
    res.status(500).json({
      success: false,
      message: 'Error al agregar comentario',
      error: error.message
    });
  }
});

app.delete('/api/comentarios/:negocioId/:comentarioId', async (req, res) => {
  console.log(`📡 DELETE /api/comentarios/${req.params.negocioId}/${req.params.comentarioId}`);
  try {
    const { username, adminUsername } = req.body; 
    
    const negocioRef = db.collection('negocios').doc(req.params.negocioId);
    const negocioDoc = await negocioRef.get();

    if (!negocioDoc.exists) {
      return res.status(404).json({ success: false, message: 'Negocio no encontrado' });
    }

    const negocioData = negocioDoc.data();
    const esAdminUser = adminUsername && esAdmin(adminUsername);
    const esPropietario = username && negocioData.propietarioUsername === username;

    if (!esAdminUser && !esPropietario) {
      return res.status(403).json({ success: false, message: 'Sin permisos para eliminar este comentario' });
    }

    const comentarioRef = negocioRef.collection('comentarios').doc(req.params.comentarioId);
    const comentarioDoc = await comentarioRef.get();

    if (!comentarioDoc.exists) {
      return res.status(404).json({ success: false, message: 'Comentario no encontrado' });
    }

    const comentarioData = comentarioDoc.data();
    const puntuacionEliminada = comentarioData.puntuacion || 0;

    await comentarioRef.delete();

    const totalComentarios = Math.max(0, (negocioData.totalComentarios || 0) - 1);
    let totalPuntuaciones = negocioData.totalPuntuaciones || 0;
    let sumaPuntuaciones = negocioData.sumaPuntuaciones || 0;

    if (puntuacionEliminada > 0) {
      totalPuntuaciones = Math.max(0, totalPuntuaciones - 1);
      sumaPuntuaciones = Math.max(0, sumaPuntuaciones - puntuacionEliminada);
    }

    const promedioPuntuacion = totalPuntuaciones > 0 ? sumaPuntuaciones / totalPuntuaciones : null;

    await negocioRef.update({
      totalComentarios,
      totalPuntuaciones,
      sumaPuntuaciones,
      promedioPuntuacion,
    });

    console.log(`✅ Comentario ${req.params.comentarioId} eliminado por ${esAdminUser ? 'Admin ' + adminUsername : 'Dueño ' + username}`);
    res.json({ success: true, message: 'Comentario eliminado correctamente' });
  } catch (error) {
    console.error('❌ Error al eliminar comentario:', error);
    res.status(500).json({
      success: false,
      message: 'Error al eliminar comentario',
      error: error.message
    });
  }
});

// ========== RUTAS PARA REPORTES DE LUZ ==========

app.get('/api/reportes-luz', async (req, res) => {
  console.log('📡 GET /api/reportes-luz');
  try {
    const ahora = new Date();
    const limite = new Date(ahora.getTime() - 2 * 60 * 60 * 1000);
    const snapshot = await db.collection('reportes_luz')
      .where('timestamp', '>=', limite)
      .orderBy('timestamp', 'desc')
      .get();
    const reportes = [];
    snapshot.forEach(doc => {
      reportes.push({ id: doc.id, ...doc.data() });
    });
    console.log(`✅ Devolviendo ${reportes.length} reportes de luz`);
    res.json({ success: true, data: reportes });
  } catch (error) {
    console.error('❌ Error al obtener reportes de luz:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener reportes de luz',
      error: error.message
    });
  }
});

app.post('/api/reportes-luz', async (req, res) => {
  console.log('📡 POST /api/reportes-luz');
  try {
    const { latitud, longitud, estado } = req.body;
    console.log('📝 Datos recibidos:', { latitud, longitud, estado });
    if (latitud === undefined || longitud === undefined || estado === undefined) {
      return res.status(400).json({ success: false, message: 'Faltan campos: latitud, longitud, estado' });
    }
    const reporteData = {
      latitud: parseFloat(latitud),
      longitud: parseFloat(longitud),
      estado: estado === true || estado === 'true' ? true : false,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    };
    const docRef = await db.collection('reportes_luz').add(reporteData);
    console.log(`✅ Reporte de luz guardado con ID: ${docRef.id} (estado: ${reporteData.estado})`);
    res.status(201).json({
      success: true,
      message: 'Reporte guardado correctamente',
      id: docRef.id
    });
  } catch (error) {
    console.error('❌ Error al guardar reporte de luz:', error);
    res.status(500).json({
      success: false,
      message: 'Error al guardar reporte de luz',
      error: error.message
    });
  }
});

// ========== ⭐ NOTIFICACIONES PUSH (FCM) ==========

app.post('/api/notificaciones/registrar-token', async (req, res) => {
  try {
    const { token, username } = req.body;
    if (!token) {
      return res.status(400).json({ success: false, message: 'Token requerido' });
    }

    await db.collection('dispositivos').doc(token).set({
      token,
      username: username || null,
      registradoEn: admin.firestore.FieldValue.serverTimestamp(),
      activo: true,
    }, { merge: true });

    console.log(`✅ Token FCM registrado: ${token.substring(0, 20)}...`);
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Error registrando token:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/notificaciones/enviar-todos', async (req, res) => {
  try {
    const { adminUsername, titulo, mensaje } = req.body;

    if (!adminUsername || !esAdmin(adminUsername)) {
      return res.status(403).json({ success: false, message: 'Solo administradores pueden enviar notificaciones globales' });
    }

    if (!titulo || !mensaje) {
      return res.status(400).json({ success: false, message: 'Título y mensaje requeridos' });
    }

    const anuncioDoc = await db.collection('anuncios').add({
      titulo,
      mensaje,
      creadoEn: admin.firestore.FieldValue.serverTimestamp(),
      activo: true,
      enviadoPush: true,
    });
    console.log(`✅ Anuncio guardado en Firestore: ${anuncioDoc.id}`);

    const snapshot = await db.collection('dispositivos')
      .where('activo', '==', true)
      .get();

    const tokens = [];
    snapshot.forEach(doc => {
      tokens.push(doc.data().token);
    });

    if (tokens.length === 0) {
      return res.json({ 
        success: true, 
        enviados: 0, 
        fallos: 0, 
        total: 0, 
        anuncioId: anuncioDoc.id,
        mensaje: 'No hay dispositivos registrados. El anuncio se guardó para cuando abran la app.' 
      });
    }

    console.log(`📡 Enviando push a ${tokens.length} dispositivos...`);

    const batchSize = 500;
    let totalEnviados = 0;
    let totalFallos = 0;

    for (let i = 0; i < tokens.length; i += batchSize) {
      const batch = tokens.slice(i, i + batchSize);
      
      const message = {
        notification: {
          title: titulo,
          body: mensaje,
        },
        data: {
          tipo: 'anuncio',
          anuncioId: anuncioDoc.id,
          timestamp: Date.now().toString(),
        },
        tokens: batch,
      };

      try {
        const response = await admin.messaging().sendEachForMulticast(message);
        totalEnviados += response.successCount;
        totalFallos += response.failureCount;

        if (response.responses) {
          const tokensInvalidos = [];
          response.responses.forEach((resp, idx) => {
            if (!resp.success) {
              const error = resp.error;
              if (error && (error.code === 'messaging/registration-token-not-registered' || 
                            error.code === 'messaging/invalid-registration-token')) {
                tokensInvalidos.push(batch[idx]);
              }
            }
          });
          
          if (tokensInvalidos.length > 0) {
            const deleteBatch = db.batch();
            tokensInvalidos.forEach(t => {
              deleteBatch.delete(db.collection('dispositivos').doc(t));
            });
            await deleteBatch.commit();
            console.log(`🗑️ ${tokensInvalidos.length} tokens inválidos eliminados`);
          }
        }
      } catch (error) {
        console.error(`❌ Error en lote ${Math.floor(i / batchSize) + 1}:`, error.message);
      }
    }

    console.log(`✅ Push enviado: ${totalEnviados} exitosos, ${totalFallos} fallos`);
    
    res.json({ 
      success: true, 
      enviados: totalEnviados, 
      fallos: totalFallos,
      total: tokens.length,
      anuncioId: anuncioDoc.id
    });
  } catch (error) {
    console.error('❌ Error enviando notificación:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/notificaciones/anuncios-activos', async (req, res) => {
  try {
    const ahora = new Date();
    const snapshot = await db.collection('anuncios')
      .where('activo', '==', true)
      .orderBy('creadoEn', 'desc')
      .limit(5)
      .get();

    const anuncios = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.expiraEn && data.expiraEn.toDate() < ahora) return;
      
      anuncios.push({ 
        id: doc.id, 
        titulo: data.titulo,
        mensaje: data.mensaje,
        creadoEn: data.creadoEn ? data.creadoEn.toDate().toISOString() : null,
      });
    });

    res.json({ success: true, data: anuncios });
  } catch (error) {
    console.error('❌ Error obteniendo anuncios:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// =========================================================
// ⭐ RUTA TRANQUI - SISTEMA DE GAMIFICACIÓN
// =========================================================

const PUNTOS_POR_TIPO = {
  normal: 10,
  verificado: 15,
  bronce: 20,
  bronceplus: 20,
  plata: 30,
  plataplus: 30,
  oro: 40,
  oroplus: 40,
};

app.post('/api/ruta-tranqui/compartir', async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ success: false, message: 'Falta username' });

    const perfilRef = db.collection('perfiles_usuarios').doc(username);
    const perfilDoc = await perfilRef.get();

    if (!perfilDoc.exists) {
      return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
    }

    const perfilData = perfilDoc.data();
    const hoy = obtenerDiaActual();

    if (perfilData.ultimaFechaCompartido === hoy) {
      return res.json({ 
        success: true, 
        puntosGanados: 0, 
        mensaje: 'Ya ganaste puntos por compartir hoy. ¡Vuelve mañana!' 
      });
    }

    await sumarPuntosYNivel(perfilRef, perfilData, 5);
    await perfilRef.update({ ultimaFechaCompartido: hoy });

    res.json({ success: true, puntosGanados: 5, mensaje: '¡+5 puntos por compartir Tranqui!' });
  } catch (error) {
    console.error('❌ Error en compartir:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/ruta-tranqui/checkin', async (req, res) => {
  try {
    const { username, negocioId, latitud, longitud } = req.body;

    if (!username || !negocioId) {
      return res.status(400).json({ success: false, message: 'Faltan campos: username, negocioId' });
    }

    const negocioRef = db.collection('negocios').doc(negocioId);
    const negocioDoc = await negocioRef.get();
    if (!negocioDoc.exists) {
      return res.status(404).json({ success: false, message: 'Negocio no encontrado' });
    }
    const negocioData = negocioDoc.data();

    if (latitud === undefined || longitud === undefined) {
      return res.status(400).json({ success: false, message: 'Se requiere ubicación GPS' });
    }
    if (negocioData.latitud && negocioData.longitud) {
      const distancia = calcularDistanciaMetros(
        latitud, longitud,
        negocioData.latitud, negocioData.longitud
      );
      if (distancia > RADIO_VALIDO_METROS) {
        return res.status(403).json({
          success: false,
          message: `Estás demasiado lejos del negocio (${Math.round(distancia)}m). Acércate más.`,
        });
      }
    }

    if (negocioData.propietarioUsername === username) {
      return res.status(403).json({ success: false, message: 'No puedes hacer check-in en tu propio negocio' });
    }
    if (negocioData.agregadoPor === username) {
      return res.status(403).json({ success: false, message: 'No puedes ganar puntos en un negocio que tú agregaste' });
    }

    const perfilRef = db.collection('perfiles_usuarios').doc(username);
    let perfilDoc = await perfilRef.get();
    let perfilData;

    if (!perfilDoc.exists) {
      perfilData = {
        puntosTotales: 0,
        puntosMesActual: 0,
        mesActual: obtenerMesActual(),
        nivel: 1,
        streakActual: 0,
        ultimoCheckIn: null,
        ultimoDiaCheckin: null,
        negociosVisitados: 0,
        totalCheckins: 0,
        negociosAgregadosHoy: 0,
        fechaUltimoNegocioAgregado: null,
        fechaRegistro: admin.firestore.FieldValue.serverTimestamp(),
        insignias: [],
      };
      await perfilRef.set(perfilData);
    } else {
      perfilData = perfilDoc.data();
      perfilData = await actualizarPerfilMes(perfilRef, perfilData);
    }

    const diaActual = obtenerDiaActual();
    if (perfilData.ultimoDiaCheckin === diaActual) {
      const inicioDia = new Date();
      inicioDia.setHours(0, 0, 0, 0);
      const checkinsHoy = await perfilRef.collection('checkins')
        .where('timestamp', '>=', inicioDia)
        .get();
      if (checkinsHoy.size >= LIMITE_CHECKINS_POR_DIA) {
        return res.status(403).json({
          success: false,
          message: `Alcanzaste el límite de ${LIMITE_CHECKINS_POR_DIA} check-ins por hoy. ¡Vuelve mañana!`,
        });
      }
    }

    const ultimoCheckinNegocio = await perfilRef.collection('checkins')
      .where('negocioId', '==', negocioId)
      .orderBy('timestamp', 'desc')
      .limit(1)
      .get();

    if (!ultimoCheckinNegocio.empty) {
      const ultimoCheckin = ultimoCheckinNegocio.docs[0].data();
      const horasDesdeUltimo = (Date.now() - ultimoCheckin.timestamp.toDate().getTime()) / (1000 * 60 * 60);
      if (horasDesdeUltimo < COOLDOWN_NEGOCIO_HORAS) {
        return res.status(403).json({
          success: false,
          message: `Ya hiciste check-in aquí hoy. Vuelve en ${Math.ceil(COOLDOWN_NEGOCIO_HORAS - horasDesdeUltimo)} horas.`,
        });
      }
    }

    let nuevoStreak;
    const ayer = new Date();
    ayer.setDate(ayer.getDate() - 1);
    const ayerStr = `${ayer.getFullYear()}-${String(ayer.getMonth() + 1).padStart(2, '0')}-${String(ayer.getDate()).padStart(2, '0')}`;

    if (perfilData.ultimoDiaCheckin === diaActual) {
      nuevoStreak = perfilData.streakActual || 1;
    } else if (perfilData.ultimoDiaCheckin === ayerStr) {
      nuevoStreak = (perfilData.streakActual || 0) + 1;
    } else {
      nuevoStreak = 1;
    }

    const { puntos, tipo } = calcularPuntosCheckin(negocioData, nuevoStreak);

    const nuevosPuntosTotales = (perfilData.puntosTotales || 0) + puntos;
    const nuevosPuntosMes = (perfilData.puntosMesActual || 0) + puntos;
    const nuevoNivel = calcularNivel(nuevosPuntosTotales);

    const yaVisitoNegocio = await perfilRef.collection('checkins')
      .where('negocioId', '==', negocioId)
      .limit(1)
      .get();
    const esNegocioNuevo = yaVisitoNegocio.empty;

    await perfilRef.update({
      puntosTotales: nuevosPuntosTotales,
      puntosMesActual: nuevosPuntosMes,
      mesActual: obtenerMesActual(),
      nivel: nuevoNivel,
      streakActual: nuevoStreak,
      ultimoCheckIn: admin.firestore.FieldValue.serverTimestamp(),
      ultimoDiaCheckin: diaActual,
      negociosVisitados: esNegocioNuevo ? (perfilData.negociosVisitados || 0) + 1 : perfilData.negociosVisitados,
      totalCheckins: (perfilData.totalCheckins || 0) + 1,
    });

    await perfilRef.collection('checkins').add({
      negocioId: negocioId,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      puntosGanados: puntos,
      distancia: latitud && longitud && negocioData.latitud && negocioData.longitud
        ? calcularDistanciaMetros(latitud, longitud, negocioData.latitud, negocioData.longitud)
        : 0,
      tipoNegocio: tipo,
    });

    const negocioAntesVerificado = negocioData.verificado === true;
    const checkinsUnicosActuales = negocioData.checkinsUnicos || 0;

    let nuevosCheckinsUnicos = checkinsUnicosActuales;
    if (esNegocioNuevo) {
      nuevosCheckinsUnicos = checkinsUnicosActuales + 1;
    }

    const ahoraVerificado = nuevosCheckinsUnicos >= CHECKINS_PARA_VERIFICAR;

    await negocioRef.update({
      checkinsUnicos: nuevosCheckinsUnicos,
      totalCheckins: (negocioData.totalCheckins || 0) + 1,
      verificado: ahoraVerificado,
    });

    const checkinsRecientes = await perfilRef.collection('checkins')
      .orderBy('timestamp', 'desc')
      .limit(150)
      .get();
    const checkinsList = checkinsRecientes.docs.map(d => d.data());
    const nuevasInsignias = await detectarInsignias(perfilRef, {
      ...perfilData,
      totalCheckins: (perfilData.totalCheckins || 0) + 1,
      negociosVisitados: esNegocioNuevo ? (perfilData.negociosVisitados || 0) + 1 : perfilData.negociosVisitados,
      streakActual: nuevoStreak,
      insignias: perfilData.insignias || [],
    }, checkinsList);

    res.json({
      success: true,
      puntosGanados: puntos,
      tipoNegocio: tipo,
      puntosTotales: nuevosPuntosTotales,
      puntosMesActual: nuevosPuntosMes,
      nivel: nuevoNivel,
      streakActual: nuevoStreak,
      negocioVerificadoAhora: ahoraVerificado && !negocioAntesVerificado,
      insigniasNuevas: nuevasInsignias.map(id => ({ id, ...INSIGNIAS[id] })),
      mensaje: `¡+${puntos} puntos! ${ahoraVerificado && !negocioAntesVerificado ? '¡Este negocio ahora está VERIFICADO!' : ''}`,
    });

  } catch (error) {
    console.error('❌ Error en check-in:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/ruta-tranqui/perfil', async (req, res) => {
  try {
    const { username } = req.query;
    if (!username) {
      return res.status(400).json({ success: false, message: 'Falta username' });
    }

    const perfilRef = db.collection('perfiles_usuarios').doc(username);
    let perfilDoc = await perfilRef.get();

    if (!perfilDoc.exists) {
      return res.json({
        success: true,
        data: {
          puntosTotales: 0,
          puntosMesActual: 0,
          nivel: 1,
          nivelNombre: 'Aprendiz',
          streakActual: 0,
          negociosVisitados: 0,
          totalCheckins: 0,
          insignias: [],
          puntosParaSiguienteNivel: 100,
        },
      });
    }

    let perfilData = perfilDoc.data();
    perfilData = await actualizarPerfilMes(perfilRef, perfilData);

    const nivelActual = NIVELES.find(n => n.nivel === perfilData.nivel) || NIVELES[0];
    const siguienteNivel = NIVELES.find(n => n.nivel === perfilData.nivel + 1);
    const puntosParaSiguiente = siguienteNivel
      ? siguienteNivel.puntos - perfilData.puntosTotales
      : 0;

    res.json({
      success: true,
      data: {
        ...perfilData,
        nivelNombre: nivelActual.nombre,
        puntosParaSiguienteNivel: puntosParaSiguiente > 0 ? puntosParaSiguiente : 0,
      },
    });
  } catch (error) {
    console.error('❌ Error obteniendo perfil:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/ruta-tranqui/ranking', async (req, res) => {
  try {
    const mesActual = obtenerMesActual();

    const snapshot = await db.collection('perfiles_usuarios')
      .orderBy('puntosMesActual', 'desc')
      .limit(50)
      .get();

    const ranking = [];
    snapshot.forEach((doc, index) => {
      const data = doc.data();
      ranking.push({
        posicion: index + 1,
        username: doc.id,
        puntosMesActual: data.puntosMesActual || 0,
        puntosTotales: data.puntosTotales || 0,
        nivel: data.nivel || 1,
        streakActual: data.streakActual || 0,
      });
    });

    res.json({
      success: true,
      mes: mesActual,
      data: ranking,
      premio: '120 CUP al #1 del mes',
    });
  } catch (error) {
    console.error('❌ Error obteniendo ranking:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/ruta-tranqui/insignias', async (req, res) => {
  try {
    const { username } = req.query;

    let insigniasUsuario = [];
    if (username) {
      const perfilDoc = await db.collection('perfiles_usuarios').doc(username).get();
      if (perfilDoc.exists) {
        insigniasUsuario = perfilDoc.data().insignias || [];
      }
    }

    const todasInsignias = Object.entries(INSIGNIAS).map(([id, data]) => ({
      id,
      ...data,
      desbloqueada: insigniasUsuario.includes(id),
    }));

    res.json({ success: true, data: todasInsignias });
  } catch (error) {
    console.error('❌ Error obteniendo insignias:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// =========================================================
// ⭐ RUTA TRANQUI - REGISTRO CON APKLIS (Opción D)
// =========================================================
app.post('/api/ruta-tranqui/registrar-con-apklis', async (req, res) => {
  try {
    const { apklisUsername } = req.body;

    if (!apklisUsername || typeof apklisUsername !== 'string') {
      return res.status(400).json({ 
        success: false, 
        message: 'Se requiere apklisUsername válido' 
      });
    }

    const usernameRegex = /^[a-zA-Z0-9_]{3,30}$/;
    if (!usernameRegex.test(apklisUsername)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Username de Apklis inválido' 
      });
    }

    const perfilRef = db.collection('perfiles_usuarios').doc(apklisUsername);
    const perfilDoc = await perfilRef.get();

    if (perfilDoc.exists) {
      const perfilData = perfilDoc.data();
      console.log(`✅ [Ruta Tranqui] Usuario existente: @${apklisUsername}`);
      return res.json({
        success: true,
        username: apklisUsername,
        esNuevoUsuario: false,
        puntosTotales: perfilData.puntosTotales || 0,
        puntosBonus: 0,
      });
    }

    const BONUS_BIENVENIDA = 50;
    const mesActual = obtenerMesActual();
    
    const perfilInicial = {
      puntosTotales: BONUS_BIENVENIDA,
      puntosMesActual: BONUS_BIENVENIDA,
      mesActual: mesActual,
      nivel: 1,
      streakActual: 0,
      ultimoCheckIn: null,
      ultimoDiaCheckin: null,
      negociosVisitados: 0,
      totalCheckins: 0,
      negociosAgregadosHoy: 0,
      fechaUltimoNegocioAgregado: null,
      fechaRegistro: admin.firestore.FieldValue.serverTimestamp(),
      insignias: ['usuario_apklis'],
      registradoCon: 'apklis',
    };

    await perfilRef.set(perfilInicial);

    console.log(`🎉 [Ruta Tranqui] Nuevo usuario registrado: @${apklisUsername} (+${BONUS_BIENVENIDA} pts de bienvenida)`);

    res.json({
      success: true,
      username: apklisUsername,
      esNuevoUsuario: true,
      puntosTotales: BONUS_BIENVENIDA,
      puntosBonus: BONUS_BIENVENIDA,
    });
  } catch (error) {
    console.error('❌ Error en registro con Apklis:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/ruta-tranqui/reset-mensual', async (req, res) => {
  try {
    const { adminUsername } = req.body;
    if (!adminUsername || !esAdmin(adminUsername)) {
      return res.status(403).json({ success: false, message: 'Solo administradores pueden resetear el ranking' });
    }

    const mesActual = obtenerMesActual();
    const snapshot = await db.collection('perfiles_usuarios').get();

    const batch = db.batch();
    let contador = 0;
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.mesActual !== mesActual) {
        batch.update(doc.ref, {
          puntosMesActual: 0,
          mesActual: mesActual,
        });
        contador++;
      }
    });
    await batch.commit();

    console.log(`✅ [ADMIN] Reset mensual: ${contador} perfiles actualizados a ${mesActual}`);
    res.json({ success: true, message: `Reset mensual completado: ${contador} perfiles actualizados` });
  } catch (error) {
    console.error('❌ Error en reset mensual:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ========== HEALTH CHECK ==========

app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// ========== INICIAR SERVIDOR ==========

app.listen(port, () => {
  console.log(`✅ Servidor proxy de Tranqui corriendo en http://localhost:${port}`);
  console.log(`📡 Endpoints:`);
  console.log(`   GET  /api/negocios (con alerta VIP segura)`);
  console.log(`   POST /api/negocios`);
  console.log(`   GET  /api/negocios/:id (con alerta VIP segura)`);
  console.log(`   PUT  /api/negocios/:id/reclamar ⭐ VIP (dueño reclama)`);
  console.log(`   PUT  /api/negocios/:id/vip      ⭐ VIP edición (bloquea si expiró)`);
  console.log(`   PUT  /api/negocios/:id/fotos    ⭐ FOTOS`);
  console.log(`   POST /api/licencias/activar`);
  console.log(`   GET  /api/licencias/vigente`);
  console.log(`   GET  /api/categorias`);
  console.log(`   PUT  /api/admin/negocios/:id   ⭐ ADMIN edición`);
  console.log(`   PUT  /api/admin/negocios/:id/vip-status ⭐ ADMIN (reclamar/liberar/extender/cambiar-tipo)`);
  console.log(`   DELETE /api/admin/negocios/:id  ⭐ ADMIN borrado total`);
  console.log(`   GET  /api/admin/stats           ⭐ ADMIN`);
  console.log(`   GET  /api/admin/verificar       ⭐ ADMIN`);
  console.log(`   POST /api/admin/poblar-categorias`);
  console.log(`   GET  /api/negocios/:id/catalogo`);
  console.log(`   GET  /api/negocios/:id/catalogo/agrupado`);
  console.log(`   POST /api/negocios/:id/catalogo`);
  console.log(`   PUT  /api/negocios/:id/catalogo/:productoId`);
  console.log(`   DELETE /api/negocios/:id/catalogo/:productoId`);
  console.log(`   GET  /api/comentarios/:negocioId`);
  console.log(`   POST /api/comentarios/:negocioId`);
  console.log(`   DELETE /api/comentarios/:negocioId/:comentarioId ⭐ BORRAR COMENTARIO (Admin/Dueño)`);
  console.log(`   GET  /api/reportes-luz`);
  console.log(`   POST /api/reportes-luz`);
  console.log(`   POST /api/notificaciones/registrar-token ⭐ FCM registro`);
  console.log(`   POST /api/notificaciones/enviar-todos    ⭐ FCM push global (admin)`);
  console.log(`   GET  /api/notificaciones/anuncios-activos ⭐ FCM fallback`);
  console.log(`   POST /api/ruta-tranqui/compartir         ⭐ GAMIFICACIÓN compartir (+5 pts/día)`);
  console.log(`   POST /api/ruta-tranqui/checkin        ⭐ GAMIFICACIÓN check-in`);
  console.log(`   GET  /api/ruta-tranqui/perfil         ⭐ GAMIFICACIÓN perfil`);
  console.log(`   GET  /api/ruta-tranqui/ranking        ⭐ GAMIFICACIÓN ranking`);
  console.log(`   GET  /api/ruta-tranqui/insignias      ⭐ GAMIFICACIÓN insignias`);
  console.log(`   POST /api/ruta-tranqui/registrar-con-apklis ⭐ GAMIFICACIÓN registro Apklis`);
  console.log(`   POST /api/ruta-tranqui/reset-mensual  ⭐ GAMIFICACIÓN reset (admin)`);
  console.log(`   GET  /api/health`);
});