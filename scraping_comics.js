const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const stealth_plugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(stealth_plugin());

// ##########
// Archivo de configuración
// ##########

// Función para crear un archivo de configuración básico si no existe
const crear_config_inicial = () => {
	// Calcular la fecha de hace 3 días
	const fecha_actual = new Date();
	fecha_actual.setDate(fecha_actual.getDate() - 3);
	const timestamp_actualizacion = fecha_actual.getTime();

	const config_inicial = {
		// Url y redirección
		"dominio_principal": "", // Indicar la web funcional. Se impone sobre 'dominio_redireccion'
		"dominio_redireccion": "", // Desde este dominio se redirige a la web funcional
		"patron_boton_nuevo_dominio": "", // Selector CSS (sería fácil adaptarlo para XPath) para identificar el botón en dominio_redireccion que lleva a la web funcional
		"ruta_scraping": "", // Se concatena para determinar de dónde obtener las fichas. Para la raíz, usar '/'
		"url_paginacion": "", // Cuando se terminen las fichas de la página actual, se usará para construir la URL a la siguiente página

		// Scraping
		"patron_ficha": "", // Selector CSS para identificar las fichas que contienen el nombre, capítulo, URL y fecha. La URL y fecha se obtienen automáticamente desde 'href' y 'datetime' (si hay varios siempre se elegirá el primero de cada uno)
		"patron_titulo": "",
		"patron_capitulo": "",

		"ruta_feed": "feed.json", // Ruta donde se guardará el JSON Feed
		"min_paginas": "2", // Mínimo de páginas a procesar
		"timestamp_actualizacion": timestamp_actualizacion // Última actualización (epoch en milisegundos)
	};

	const home = process.env.HOME || process.env.USERPROFILE;
	const ruta_config = path.join(home, 'config.json');
	fs.writeFileSync(ruta_config, JSON.stringify(config_inicial, null, '\t'));
	console.log('Archivo de configuración inicial creado en:', ruta_config);
	console.log('Ajustar los valores necesarios y volver a ejecutar el script.');
	process.exit(0);
};

const leer_y_validar_config = () => {
	let ruta_config;
	// Determinar la ruta del archivo de configuración pasado como argumento o por defecto
	if (process.argv[2]) {
		ruta_config = path.resolve(process.argv[2]);
	} else {
		const home = process.env.HOME || process.env.USERPROFILE;
		ruta_config = path.join(home, 'config.json');
	}

	// Verificar la existencia del archivo
	if (!fs.existsSync(ruta_config)) {
		console.log('Archivo de configuración no encontrado.');
		crear_config_inicial();
	} else {
		console.log(`Usando archivo de configuración: ${ruta_config}`);
	}

	let hay_errores = false;
	let config;
	// Intentar leer y parsear el JSON
	try {
		config = JSON.parse(fs.readFileSync(ruta_config, 'utf8'));
	} catch (error) {
		console.error('Error: Sintaxis JSON incorrecta en el archivo de configuración.');
		hay_errores = true;
	}

	// Validar claves
	if (config) {
		// Validar que se defina al menos uno de los dominios
		if (!config.dominio_principal && !config.dominio_redireccion) {
			console.error("Error: Definir 'dominio_principal' o 'dominio_redireccion'.");
			hay_errores = true;
		}

		// Validar la existencia del patrón del botón cuando se define redirección
		if (config.dominio_redireccion && (!config.patron_boton_nuevo_dominio || config.patron_boton_nuevo_dominio.trim() === "")) {
			console.error("Error: Está definido 'dominio_redireccion' pero falta 'patron_boton_nuevo_dominio'.");
			hay_errores = true;
		}

		const claves_necesarias = [
			"ruta_scraping",
			"url_paginacion",
			"patron_ficha",
			"patron_titulo",
			"patron_capitulo",
			"min_paginas",
			"timestamp_actualizacion"
		];
		for (const clave of claves_necesarias) {
			if (!config[clave] || config[clave].toString().trim() === "") {
				console.error(`Error: La clave '${clave}' está vacía en la configuración.`);
				hay_errores = true;
			}
		}
	}

	// Si se ha encontrado algún error, salir del programa
	if (hay_errores) {
		process.exit(1);
	}

	return { config, ruta_config };
};

// ##########
// Redirección
// ##########

// Se redirige a la web funcional si 'dominio_principal' está vacío y se usa 'dominio_redireccion'
const redirigir_dominio = async (pagina, config, navegador) => {
	console.log('Accediendo a dominio_redireccion:', config.dominio_redireccion);
	// Ir a la URL de redirección y esperar que la red esté inactiva
	await pagina.goto(config.dominio_redireccion, { waitUntil: 'networkidle2' });

	console.log('Esperando a que aparezca el botón de redirección...');
	await pagina.waitForSelector(config.patron_boton_nuevo_dominio, { timeout: 10000 });

	console.log('Botón encontrado. Preparando clic y detección de redirección...');
	// Promesa de navegación en la misma pestaña
	const promesa_navegacion = pagina.waitForNavigation({
		waitUntil: 'networkidle0',
		timeout:    10000
	}).catch(() => null);

    // Promesa que espera a que se abra una nueva pestaña iniciada desde la pestaña actual
	const promesa_nueva_pestana = navegador.waitForTarget(
		target => target.opener() === pagina.target(),
		{ timeout: 10000 }
	)
	.then(target => target.page())
	.catch(() => null);

	// Disparar el clic tras definir las promesas
	await pagina.click(config.patron_boton_nuevo_dominio);

	// Resolver la que ocurra primero: navegación o nueva pestaña
	const resultado = await Promise.race([promesa_navegacion, promesa_nueva_pestana]);

	// Si es nueva pestaña, cerrar la original y devolver la nueva
	if (resultado && typeof resultado.bringToFront === 'function') {
		console.log('Nueva pestaña detectada tras redirección.');
		await resultado.bringToFront();

		// Cerrar página original
		await pagina.close();
		console.log('Pestaña original cerrada.');

		return resultado;
	}

	// Si navegó en la misma pestaña, devolvemos esa misma
	if (resultado) {
		console.log('Redirección detectada en la misma pestaña.');
		return pagina;
	}

	// Si no ocurre nada, error
	throw new Error('Error: No se detectó redirección tras el clic.');
};

// ##########
// Scraping
// ##########

const procesar_paginas = async (pagina, config, dominio_funcional, navegador, ruta_config) => {
	let pagina_actual = 1;

	// Construir la URL inicial para scraping
	let url_scraping = `${dominio_funcional.replace(/\/$/, '')}/${config.ruta_scraping.replace(/^\//, '')}${config.url_paginacion}${pagina_actual}`;
	console.log('URL de scraping inicial:', url_scraping);

	// Bloquear recursos multimedia
	await pagina.setRequestInterception(true);
	pagina.on('request', request => {
		const tipo_recurso = request.resourceType();
		if (['image', 'media', 'font'].includes(tipo_recurso)) {
			request.abort();
		} else {
			request.continue();
		}
	});

	// Depósito temporal para las fichas
	const json_feed_base = { items: [] };

	let continuar_scrapeo = true;

	// Obtener el timestamp del archivo de configuración
	const umbral_timestamp = parseInt(config.timestamp_actualizacion, 10);

	// Almacenar el timestamp más antiguo encontrado encontrado, para actualizar al final)
	let timestamp_reciente = umbral_timestamp;

	while (continuar_scrapeo) {
		console.log(`\nProcesando página ${pagina_actual}...`);

		try {
			await pagina.goto(url_scraping, { waitUntil: 'networkidle2' });
		} catch (error) {
			console.error('Error al acceder a la página:', error);
			break;
		}

		// Espera extra para que cargue el contenido dinámico
		await new Promise(resolve => setTimeout(resolve, 3000));

		// Extraer fichas y sus contenidos
		const fichas = await pagina.$$eval(
			config.patron_ficha,
			(elementos, patron_titulo, patron_capitulo) => {
				return elementos.map(el => {
					// Título
					let elemento_titulo = el.querySelector(patron_titulo);
					let titulo  = elemento_titulo ? elemento_titulo.innerText.trim() : "";

					// Capítulo
					let elemento_capitulo = el.querySelector(patron_capitulo);
					let capitulo = elemento_capitulo ? elemento_capitulo.innerText.trim() : "";

					// Enlace (auto desde etiquetas comunes, seleccionará el primero)
					let elemento_a = el.querySelector("a[href]");
					let url = elemento_a ? elemento_a.href.trim() : "";

					// Fecha (auto desde etiquetas comunes, seleccionará el primero)
					let elemento_time = el.querySelector("time[datetime]");
					let fecha = elemento_time ? elemento_time.getAttribute("datetime").trim() : "";

					return { titulo, url, fecha, capitulo };
				});
			},
			config.patron_titulo,
			config.patron_capitulo
		).catch(error => {
			console.error('Error al extraer fichas:', error);
			return [];
		});

		// Si no se encontraron fichas, salir si el feed está vacío
		if (!fichas || fichas.length === 0) {
			if (json_feed_base.items.length === 0) {
				console.error(`No se encontraron fichas en la página ${pagina_actual}. Finalizando con error.`);
				process.exit(1);
			} else {
				console.log(`No se encontraron fichas en la página ${pagina_actual}, finalizando el scraping.`);
				break;
			}
		}

		console.log(`Fichas encontradas en la página ${pagina_actual}: ${fichas.length}`);

		let alguna_ficha_reciente = false;
		let alguna_fecha_valida = false; // Para controlar si al menos una ficha tiene fecha en esta página

		// Procesar cada ficha encontrada
		for (const ficha of fichas) {

			// Advertir por falta de capítulo, lo que podría suceder en fichas apenas inicializadas
			if (!ficha.capitulo) {
				console.warn(`Ficha ignorada por falta de capítulo: "${ficha.titulo}" | "${ficha.capitulo}" | "${ficha.fecha}" | "${ficha.url}"`);
				continue;
			}

			// Se obtiene la fecha (en timestamp), si se dispone de ella
			let fecha_ficha = null;
			if (ficha.fecha) {
				fecha_ficha = new Date(ficha.fecha).getTime();
				if (!isNaN(fecha_ficha)) {
					alguna_fecha_valida = true;
				} else {
					console.warn(`Ficha con fecha defectuosa: "${ficha.titulo}" | "${ficha.capitulo}" | "${ficha.fecha}" | "${ficha.url}"`);
				}
			}

			// Verificar si hay URL válida
			if (!ficha.url || typeof ficha.url !== 'string' || ficha.url.trim() === '') {
				console.error(`Ficha sin una URL válida: "${ficha.titulo}" | "${ficha.capitulo}" | "${ficha.fecha}" | "${ficha.url}"`);
				process.exit(1);
			}

			// Registrar la ficha en el feed
			json_feed_base.items.push({
				title: ficha.titulo,
				chapter: ficha.capitulo,
				url: ficha.url
			});

			// Log de fichas encontradas
			if (fecha_ficha !== null && !isNaN(fecha_ficha)) {
				if (fecha_ficha > umbral_timestamp) {
					console.log(`Ficha (NUEVA): "${ficha.titulo}" | "${ficha.capitulo}" | "${ficha.fecha}" | "${ficha.url}"`);
					alguna_ficha_reciente = true;
				} else {
					console.log(`Ficha: "${ficha.titulo}" | "${ficha.capitulo}" | "${ficha.fecha}" | "${ficha.url}"`);
				}

				if (fecha_ficha > timestamp_reciente) {
					timestamp_reciente = fecha_ficha;
				}
			} else {
				console.warn(`La ficha no dispone de una fecha válida: ${ficha.titulo}`);
			}
		}

		if (!alguna_fecha_valida) {
			console.error("Error: Ninguna ficha en la página posee fecha válida. Posible cambio en el formato de la web. Abortando.");
			process.exit(1);
		}

		if (!alguna_ficha_reciente && pagina_actual >= parseInt(config.min_paginas, 10)) {
			console.log("No se encontraron fichas nuevas y se ha alcanzado el mínimo de páginas. Se detiene el scraping.");
			continuar_scrapeo = false;
		} else {
			pagina_actual++;
			url_scraping = `${dominio_funcional.replace(/\/$/, '')}/${config.ruta_scraping.replace(/^\//, '')}${config.url_paginacion}${pagina_actual}`;
		}
	}

	// Se actualiza el timestamp del archivo de configuración si se encontró uno mayor
	if (timestamp_reciente > umbral_timestamp) {
		config.timestamp_actualizacion = timestamp_reciente.toString();
	}

	return json_feed_base;
};

// ##########
// JSON Feed
// ##########

const generar_feed_final = (feed_base) => {
	const feed_final = {
		version: "https://jsonfeed.org/version/1.1",
		title: "Nuevos capítulos",
		items: []
	};

	// Mapa para garantizar unicidad por título+capítulo y permitir actualizar URL
	const mapa_items = new Map();

	feed_base.items.forEach((item) => {
		const titulo_completo = `${item.title.trim()} [${item.chapter.trim()}]`;

		if (!mapa_items.has(titulo_completo)) {
			// Si no existe, se añade al mapa
			mapa_items.set(titulo_completo, {
				id: titulo_completo,
				title: titulo_completo,
				url: item.url
			});
		} else {
			// Si ya existe, solo se actualiza la URL
			const item_existente = mapa_items.get(titulo_completo);
			item_existente.url = item.url;
		}
	});

	// Transferir los valores del mapa al array final
	feed_final.items = Array.from(mapa_items.values());

	// Eliminar los items más antiguos si el total supera 100, hasta quedar solo 100
	if (feed_final.items.length > 100) {
		feed_final.items = feed_final.items.slice(-100);
	}

	return feed_final;
};

// ##########
// Función principal
// ##########

const ejecutar_script = async () => {
	const { config, ruta_config } = leer_y_validar_config();

	console.log('Iniciando Puppeteer.');
	const navegador = await puppeteer.launch({
		headless: true,
		args: ['--no-sandbox', '--disable-setuid-sandbox'] // para github actions
	});
	let pagina = await navegador.newPage();
	console.log('Página web creada.');

	// Redirección, si no se ha definido 'dominio_principal'
	if (!config.dominio_principal && config.dominio_redireccion) {
		pagina = await redirigir_dominio(pagina, config, navegador);
	}

	// Determinar el dominio funcional para el scraping
	const url_actual = pagina.url();
	const dominio_funcional = config.dominio_principal || url_actual;
	console.log('Dominio funcional para el scraping:', dominio_funcional);

	// Ejecutar el scraping
	const feed_base = await procesar_paginas(pagina, config, dominio_funcional, navegador, ruta_config);

	// Generar el JSON Feed final en el formato deseado
	const feed_final = generar_feed_final(feed_base);

	// Escribir el feed y config en el disco
	fs.writeFileSync(config.ruta_feed, JSON.stringify(feed_final, null, "\t"));
	fs.writeFileSync(ruta_config, JSON.stringify(config, null, "\t"), 'utf8');

	// Cerrar navegador y finalizar
	await navegador.close();
	console.log('Navegador cerrado. Script finalizado.');
	process.exit(0);
};

ejecutar_script();
