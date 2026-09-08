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
// ⭐ CATEGORÍAS VÁLIDAS (fuente de verdad del backend)
// Debe coincidir con lib/data/categorias.dart en Flutter
// =========================================================
const CATEGORIAS_VALIDAS = [
  // Comida
  'restaurante', 'cafeteria', 'bar', 'comida_rapida', 'reposteria', 'elaborador_alimentos',
  // Compras
  'mercado', 'supermercado', 'ropa_calzado', 'ferreteria', 'farmacia', 'electronica', 'papeleria',
  // Belleza
  'peluqueria', 'salon_belleza', 'tatuajes',
  // Talleres
  'taller_electronica', 'reparacion_celulares', 'taller_mecanico', 'costura',
  // Ocio
  'sala_juegos', 'cibercafe', 'eventos',
  // Salud
  'consulta_medica', 'veterinaria',
  // Transporte
  'taxi', 'transporte_provincial', 'alquiler_vehiculos',
  // Servicios
  'fotografia', 'gestoria', 'tutorias', 'recargas',
  // Válvula de escape
  'otros',
];

// =========================================================
// ⭐ USUARIOS ADMIN
// Estos usuarios pueden editar/borrar CUALQUIER negocio
// =========================================================
const ADMIN_USERNAMES = [
  'noblesse',    // ← CAMBIA ESTO
  // Puedes agregar más admins aquí:
  // 'otro_admin',
];

function esAdmin(username) {
  return ADMIN_USERNAMES.includes(username);
}

// =========================================================
// ⭐ HELPER: Validar categorías de un negocio
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
    
    snapshot.forEach(doc => {
      const data = doc.data();
      
      let esVipVigente = false;
      if (data.esVip && data.vipHasta) {
        const vipHasta = data.vipHasta.toDate();
        esVipVigente = vipHasta > ahora;
        if (esVipVigente) contadorVip++;
      }
      
      negocios.push({ 
        id: doc.id, 
        ...data,
        esVip: esVipVigente
      });
    });
    
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
    } = req.body;
    console.log('📝 Datos recibidos:', { nombre, provincia, municipio, categoriaPrincipal });
    
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
    
    // ⭐ Validar categorías
    const validacion = validarCategorias(categoriaPrincipal, categoriasSecundarias);
    if (!validacion.valido) {
      return res.status(400).json({ success: false, message: validacion.error });
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
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    };
    
    const docRef = await db.collection('negocios').add(negocioData);
    console.log(`✅ Negocio agregado con ID: ${docRef.id} (${provincia} - ${municipio}) [Categoría: ${categoriaPrincipal}]`);
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
    const ahora = new Date();
    let esVipVigente = false;
    if (data.esVip && data.vipHasta) {
      const vipHasta = data.vipHasta.toDate();
      esVipVigente = vipHasta > ahora;
    }
    
    res.json({ 
      success: true, 
      data: { 
        id: doc.id, 
        ...data,
        esVip: esVipVigente
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

// ⭐ ENDPOINT TEMPORAL: Poblar categorías en Firestore
// ⚠️ ELIMINAR ESTE ENDPOINT DESPUÉS DE USARLO UNA VEZ
app.post('/api/admin/poblar-categorias', async (req, res) => {
  const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'TRANQUI_ADMIN_2026';
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN) {
    return res.status(403).json({ success: false, message: 'Sin autorización' });
  }

  try {
    const categoriasDefinicion = [
      { id: 'restaurante', nombre: 'Restaurante / Paladar', grupo: 'comida', orden: 1 },
      { id: 'cafeteria', nombre: 'Cafetería / Cafetín', grupo: 'comida', orden: 2 },
      { id: 'bar', nombre: 'Bar / Centro nocturno', grupo: 'comida', orden: 3 },
      { id: 'comida_rapida', nombre: 'Pizzería / Comida rápida', grupo: 'comida', orden: 4 },
      { id: 'reposteria', nombre: 'Repostería / Dulcería', grupo: 'comida', orden: 5 },
      { id: 'elaborador_alimentos', nombre: 'Elaborador de alimentos (MIPYME)', grupo: 'comida', orden: 6 },
      { id: 'mercado', nombre: 'Mercado / Bodega / Tienda', grupo: 'compras', orden: 1 },
      { id: 'supermercado', nombre: 'Supermercado / Minisuper', grupo: 'compras', orden: 2 },
      { id: 'ropa_calzado', nombre: 'Tienda de ropa y calzado', grupo: 'compras', orden: 3 },
      { id: 'ferreteria', nombre: 'Ferretería / Materiales de construcción', grupo: 'compras', orden: 4 },
      { id: 'farmacia', nombre: 'Farmacia / Óptica', grupo: 'compras', orden: 5 },
      { id: 'electronica', nombre: 'Tienda de celulares / Electrónica', grupo: 'compras', orden: 6 },
      { id: 'papeleria', nombre: 'Librería / Papelería / Imprenta', grupo: 'compras', orden: 7 },
      { id: 'peluqueria', nombre: 'Peluquería / Barbería', grupo: 'belleza', orden: 1 },
      { id: 'salon_belleza', nombre: 'Salón de belleza / Uñas / Spa', grupo: 'belleza', orden: 2 },
      { id: 'tatuajes', nombre: 'Tatuajes / Piercings', grupo: 'belleza', orden: 3 },
      { id: 'taller_electronica', nombre: 'Taller de electrónica', grupo: 'talleres', orden: 1 },
      { id: 'reparacion_celulares', nombre: 'Reparación de celulares', grupo: 'talleres', orden: 2 },
      { id: 'taller_mecanico', nombre: 'Taller mecánico / Gomería', grupo: 'talleres', orden: 3 },
      { id: 'costura', nombre: 'Costura / Zapatería / Cerrajería', grupo: 'talleres', orden: 4 },
      { id: 'sala_juegos', nombre: 'Sala de juegos / Videojuegos / Billar', grupo: 'ocio', orden: 1 },
      { id: 'cibercafe', nombre: 'Cibercafé / Navegación / Punto WiFi', grupo: 'ocio', orden: 2 },
      { id: 'eventos', nombre: 'Eventos / Fiestas / Alquiler de salón', grupo: 'ocio', orden: 3 },
      { id: 'consulta_medica', nombre: 'Consultorio / Clínica privada', grupo: 'salud', orden: 1 },
      { id: 'veterinaria', nombre: 'Veterinaria / Pet shop', grupo: 'salud', orden: 2 },
      { id: 'taxi', nombre: 'Taxi / Transportista local', grupo: 'transporte', orden: 1 },
      { id: 'transporte_provincial', nombre: 'Transporte interprovincial / Encomiendas', grupo: 'transporte', orden: 2 },
      { id: 'alquiler_vehiculos', nombre: 'Alquiler de vehículos / Bicicletas', grupo: 'transporte', orden: 3 },
      { id: 'fotografia', nombre: 'Fotografía / Diseño', grupo: 'servicios', orden: 1 },
      { id: 'gestoria', nombre: 'Gestor / Contador / Asesor', grupo: 'servicios', orden: 2 },
      { id: 'tutorias', nombre: 'Tutorías / Academia / Clases', grupo: 'servicios', orden: 3 },
      { id: 'recargas', nombre: 'Punto de recarga / Transfermóvil / CADECA', grupo: 'servicios', orden: 4 },
      { id: 'otros', nombre: 'Otros servicios', grupo: 'otros', orden: 99 },
    ];

    const batch = db.batch();
    categoriasDefinicion.forEach(cat => {
      const ref = db.collection('categorias').doc(cat.id);
      batch.set(ref, { ...cat, activo: true });
    });

    await batch.commit();

    console.log(`✅ ${categoriasDefinicion.length} categorías pobladas en Firestore`);
    res.json({
      success: true,
      message: `${categoriasDefinicion.length} categorías pobladas correctamente`,
      categorias: categoriasDefinicion.map(c => c.id)
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
      return res.status(400).json({ 
        success: false, 
        message: 'Faltan campos: username, tipoVip, vipHasta' 
      });
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
        return res.status(409).json({ 
          success: false, 
          message: `Este negocio ya fue reclamado por @${negocioData.propietarioUsername}` 
        });
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
    if (t.includes('oro')) limite = 10;
    else if (t.includes('plata')) limite = 5;
    else if (t.includes('bronce')) limite = 1;
    else if (t.includes('prueba')) limite = 1;

    const esMismoNegocio = idsVigentes.includes(req.params.id);
    
    if (!esMismoNegocio && negociosVigentes >= limite) {
      return res.status(403).json({ 
        success: false, 
        message: `Has alcanzado el límite de ${limite} negocio(s) para el plan ${tipoVip}. Libera uno primero.` 
      });
    }

    await negocioRef.update({
      esVip: true,
      tipoVip: tipoVip.toLowerCase(),
      propietarioUsername: username,
      vipHasta: admin.firestore.Timestamp.fromDate(new Date(vipHasta)),
      timestampVip: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`✅ Negocio ${req.params.id} reclamado por @${username} (Plan: ${tipoVip})`);
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

app.put('/api/negocios/:id/liberar', async (req, res) => {
  console.log(`📡 PUT /api/negocios/${req.params.id}/liberar`);
  try {
    const { username } = req.body;

    if (!username) {
      return res.status(400).json({ 
        success: false, 
        message: 'Falta campo: username' 
      });
    }

    const negocioRef = db.collection('negocios').doc(req.params.id);
    const negocioDoc = await negocioRef.get();

    if (!negocioDoc.exists) {
      return res.status(404).json({ success: false, message: 'Negocio no encontrado' });
    }

    const negocioData = negocioDoc.data();

    if (negocioData.propietarioUsername !== username) {
      return res.status(403).json({ 
        success: false, 
        message: 'No tienes permiso para liberar este negocio' 
      });
    }

    await negocioRef.update({
      esVip: false,
      tipoVip: null,
      propietarioUsername: null,
      vipHasta: null,
      descripcionVip: null,
      timestampLiberacion: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`✅ Negocio ${req.params.id} liberado por @${username}`);
    res.json({
      success: true,
      message: 'Negocio liberado correctamente'
    });
  } catch (error) {
    console.error('❌ Error al liberar negocio:', error);
    res.status(500).json({
      success: false,
      message: 'Error al liberar negocio',
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
      return res.status(400).json({ 
        success: false, 
        message: 'Falta campo: username' 
      });
    }

    const negocioRef = db.collection('negocios').doc(req.params.id);
    const negocioDoc = await negocioRef.get();

    if (!negocioDoc.exists) {
      return res.status(404).json({ success: false, message: 'Negocio no encontrado' });
    }

    const negocioData = negocioDoc.data();

    if (negocioData.propietarioUsername !== username) {
      return res.status(403).json({ 
        success: false, 
        message: 'No tienes permiso para editar este negocio' 
      });
    }

    if (!negocioData.esVip || !negocioData.vipHasta) {
      return res.status(403).json({ 
        success: false, 
        message: 'Este negocio no es VIP' 
      });
    }

    const vipHasta = negocioData.vipHasta.toDate();
    if (vipHasta <= new Date()) {
      return res.status(403).json({ 
        success: false, 
        message: 'La licencia VIP ha expirado' 
      });
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
    res.json({
      success: true,
      message: 'Negocio actualizado correctamente'
    });
  } catch (error) {
    console.error('❌ Error al actualizar negocio:', error);
    res.status(500).json({
      success: false,
      message: 'Error al actualizar negocio',
      error: error.message
    });
  }
});

// ========== RUTAS DE ADMIN ⭐ NUEVO ==========

// ⭐ ADMIN: Editar cualquier negocio (sin ser propietario)
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
      return res.status(400).json({
        success: false,
        message: 'Falta campo: adminUsername',
      });
    }

    if (!esAdmin(adminUsername)) {
      console.log(`⛔ Acceso admin denegado a: @${adminUsername}`);
      return res.status(403).json({
        success: false,
        message: 'No tienes permisos de administrador',
      });
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
    res.json({
      success: true,
      message: 'Negocio actualizado por administrador',
    });
  } catch (error) {
    console.error('❌ Error admin al actualizar:', error);
    res.status(500).json({
      success: false,
      message: 'Error al actualizar negocio',
      error: error.message,
    });
  }
});

// ⭐ ADMIN: Borrar cualquier negocio
app.delete('/api/admin/negocios/:id', async (req, res) => {
  console.log(`📡 DELETE /api/admin/negocios/${req.params.id}`);
  try {
    const { adminUsername } = req.body;

    if (!adminUsername) {
      return res.status(400).json({
        success: false,
        message: 'Falta campo: adminUsername',
      });
    }

    if (!esAdmin(adminUsername)) {
      return res.status(403).json({
        success: false,
        message: 'No tienes permisos de administrador',
      });
    }

    const negocioRef = db.collection('negocios').doc(req.params.id);
    const negocioDoc = await negocioRef.get();

    if (!negocioDoc.exists) {
      return res.status(404).json({ success: false, message: 'Negocio no encontrado' });
    }

    // Borrar comentarios de la subcolección primero
    const comentariosRef = negocioRef.collection('comentarios');
    const comentariosSnap = await comentariosRef.get();
    const batch = db.batch();
    comentariosSnap.forEach(doc => batch.delete(doc.ref));
    batch.delete(negocioRef);
    await batch.commit();

    console.log(`✅ [ADMIN] Negocio ${req.params.id} borrado por @${adminUsername}`);
    res.json({
      success: true,
      message: 'Negocio eliminado correctamente',
    });
  } catch (error) {
    console.error('❌ Error admin al borrar:', error);
    res.status(500).json({
      success: false,
      message: 'Error al borrar negocio',
      error: error.message,
    });
  }
});

// ⭐ ADMIN: Estadísticas del sistema
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
    const porCategoria = {};
    const porPlan = {};

    negociosSnap.forEach(doc => {
      const data = doc.data();

      if (data.esVip && data.vipHasta) {
        const vipHasta = data.vipHasta.toDate();
        if (vipHasta > ahora) {
          vipVigentes++;
          const plan = data.tipoVip || 'desconocido';
          porPlan[plan] = (porPlan[plan] || 0) + 1;
        }
      }

      const cat = data.categoriaPrincipal || 'sin_categoria';
      porCategoria[cat] = (porCategoria[cat] || 0) + 1;
    });

    res.json({
      success: true,
      data: {
        totalNegocios,
        vipVigentes,
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
    const { texto, autor, puntuacion } = req.body;

    if (!texto || texto.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'El texto del comentario es obligatorio'
      });
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

    const negocioRef = db.collection('negocios').doc(req.params.negocioId);
    const negocioDoc = await negocioRef.get();
    const negocioData = negocioDoc.data();

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
      return res.status(400).json({
        success: false,
        message: 'Faltan campos: latitud, longitud, estado'
      });
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
  console.log(`   GET  /api/negocios (con soporte VIP)`);
  console.log(`   POST /api/negocios (con provincia + categorías) ⭐`);
  console.log(`   GET  /api/negocios/:id`);
  console.log(`   PUT  /api/negocios/:id/reclamar ⭐ VIP`);
  console.log(`   PUT  /api/negocios/:id/liberar  ⭐ VIP`);
  console.log(`   PUT  /api/negocios/:id/vip      ⭐ VIP (+ categorías)`);
  console.log(`   GET  /api/categorias ⭐`);
  console.log(`   PUT  /api/admin/negocios/:id   ⭐ ADMIN`);
  console.log(`   DELETE /api/admin/negocios/:id  ⭐ ADMIN`);
  console.log(`   GET  /api/admin/stats           ⭐ ADMIN`);
  console.log(`   POST /api/admin/poblar-categorias (temporal) ⚠️`);
  console.log(`   GET  /api/comentarios/:negocioId`);
  console.log(`   POST /api/comentarios/:negocioId`);
  console.log(`   GET  /api/reportes-luz`);
  console.log(`   POST /api/reportes-luz`);
  console.log(`   GET  /api/health`);
});