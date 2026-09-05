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
    const { nombre, descripcion, latitud, longitud, provincia, municipio } = req.body;
    console.log('📝 Datos recibidos:', { nombre, descripcion, latitud, longitud, provincia, municipio });
    
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
    
    const negocioData = {
      nombre: nombre.trim(),
      descripcion: descripcion ? descripcion.trim() : '',
      latitud: parseFloat(latitud),
      longitud: parseFloat(longitud),
      provincia: provincia.trim(),
      municipio: municipio.trim(),
      esVip: false,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    };
    
    const docRef = await db.collection('negocios').add(negocioData);
    console.log(`✅ Negocio agregado con ID: ${docRef.id} (${provincia} - ${municipio})`);
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

// ========== RUTAS PARA GESTIÓN VIP ⭐ NUEVO ==========

// ⭐ RECLAMAR NEGOCIO COMO VIP
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

    // ⭐ Verificar si ya está reclamado por otro usuario
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

    // ⭐ Contar cuántos negocios VIP vigentes tiene este usuario
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

    // ⭐ Verificar límite según el plan
    const limites = { 'prueba': 1, 'bronce': 1, 'plata': 5, 'oro': 10 };
    const limite = limites[tipoVip.toLowerCase()] || 1;

    // Si el negocio que está reclamando YA es suyo (re-renovar), no cuenta contra el límite
    const esMismoNegocio = idsVigentes.includes(req.params.id);
    
    if (!esMismoNegocio && negociosVigentes >= limite) {
      return res.status(403).json({ 
        success: false, 
        message: `Has alcanzado el límite de ${limite} negocio(s) para el plan ${tipoVip}. Libera uno primero.` 
      });
    }

    // ⭐ Actualizar el negocio
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

// ⭐ LIBERAR NEGOCIO VIP
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

    // ⭐ Verificar que el usuario sea el propietario
    if (negocioData.propietarioUsername !== username) {
      return res.status(403).json({ 
        success: false, 
        message: 'No tienes permiso para liberar este negocio' 
      });
    }

    // ⭐ Liberar el negocio
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

// ⭐ ACTUALIZAR DATOS DE NEGOCIO VIP
app.put('/api/negocios/:id/vip', async (req, res) => {
  console.log(`📡 PUT /api/negocios/${req.params.id}/vip`);
  try {
    const { username, descripcionVip, telefono, whatsapp, horario, nombre, descripcion } = req.body;

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

    // ⭐ Verificar que el usuario sea el propietario
    if (negocioData.propietarioUsername !== username) {
      return res.status(403).json({ 
        success: false, 
        message: 'No tienes permiso para editar este negocio' 
      });
    }

    // ⭐ Verificar que el VIP esté vigente
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

    // ⭐ Actualizar campos
    const updateData = {
      timestampActualizacion: admin.firestore.FieldValue.serverTimestamp()
    };

    if (descripcionVip !== undefined) updateData.descripcionVip = descripcionVip;
    if (telefono !== undefined) updateData.telefono = telefono;
    if (whatsapp !== undefined) updateData.whatsapp = whatsapp;
    if (horario !== undefined) updateData.horario = horario;
    if (nombre !== undefined) updateData.nombre = nombre;
    if (descripcion !== undefined) updateData.descripcion = descripcion;

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

    // Actualizar estadísticas del negocio
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
  console.log(`   POST /api/negocios (con provincia)`);
  console.log(`   GET  /api/negocios/:id`);
  console.log(`   PUT  /api/negocios/:id/reclamar ⭐ VIP`);
  console.log(`   PUT  /api/negocios/:id/liberar  ⭐ VIP`);
  console.log(`   PUT  /api/negocios/:id/vip      ⭐ VIP`);
  console.log(`   GET  /api/comentarios/:negocioId`);
  console.log(`   POST /api/comentarios/:negocioId`);
  console.log(`   GET  /api/reportes-luz`);
  console.log(`   POST /api/reportes-luz`);
  console.log(`   GET  /api/health`);
});