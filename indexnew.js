const express = require('express');
const axios = require('axios');
const { parseStringPromise } = require('xml2js');
const zlib = require('zlib');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Add CORS headers for Stremio
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Simple cache with memory management
const cache = {
  channels: [],
  genres: [],
  epgData: null,
  lastUpdate: null,
  m3uUrl: null,
  maxChannels: 10000,
  epgLastUpdate: null
};

// Base config
const config = {
  port: process.env.PORT || 10000,
  manifest: {
    id: 'org.omgtv.slim',
    version: '1.0.0',
    name: 'OMG TV Slim',
    description: 'Lightweight M3U playlist addon with EPG support',
    logo: 'https://github.com/mik25/OMG-Premium-TV/blob/main/tv.png?raw=true',
    resources: ['stream', 'catalog'],
    types: ['tv'],
    idPrefixes: ['tv'],
    catalogs: [{
      type: 'tv',
      id: 'omg_tv',
      name: 'OMG TV',
      extra: [
        { name: 'genre', isRequired: false, options: [] },
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    }]
  }
};

// M3U Parser - Optimized
async function parseM3U(urls) {
  console.log('📡 Raw M3U URLs:', urls);
  
  // Handle multiple levels of URL encoding
  let decodedUrls = urls;
  try {
    while (decodedUrls.includes('%')) {
      const newDecoded = decodeURIComponent(decodedUrls);
      if (newDecoded === decodedUrls) break;
      decodedUrls = newDecoded;
    }
    decodedUrls = decodedUrls.replace(/&#38;/g, '&').replace(/&amp;/g, '&');
    decodedUrls = decodedUrls.replace(/&(epg|language|update_interval|epg_enabled)=[^,]*/g, '');
  } catch (e) {
    console.log('URL decode error, using original:', e.message);
    decodedUrls = urls;
  }
  
  console.log('📡 Decoded M3U URLs:', decodedUrls);
  const urlList = decodedUrls.split(',').map(u => u.trim()).filter(u => u && u.startsWith('http'));
  
  console.log('📋 Found URLs:', urlList.length);
  
  const channels = [];
  const genres = new Set(['Other Channels']);
  
  for (let urlIndex = 0; urlIndex < urlList.length; urlIndex++) {
    const url = urlList[urlIndex];
    console.log(`📄 Processing URL ${urlIndex + 1}/${urlList.length}: ${url.substring(0, 50)}...`);
    
    try {
      const response = await axios.get(url, { 
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        maxContentLength: 100 * 1024 * 1024, // 100MB limit
        maxBodyLength: 100 * 1024 * 1024
      });
      
      const lines = response.data.split('\n');
      let currentChannel = null;
      let channelCount = 0;
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        if (line.startsWith('#EXTINF:')) {
          const metadata = line.substring(8).trim();
          
          const nameMatch = metadata.match(/,(.*)$/);
          const name = nameMatch ? nameMatch[1].trim() : 'Unknown';
          
          const tvgIdMatch = metadata.match(/tvg-id="([^"]+)"/);
          const tvgId = tvgIdMatch ? tvgIdMatch[1] : name.toLowerCase().replace(/[^\w]/g, '_');
          
          const logoMatch = metadata.match(/tvg-logo="([^"]+)"/);
          const logo = logoMatch ? logoMatch[1] : null;
          
          const groupMatch = metadata.match(/group-title="([^"]+)"/);
          const group = groupMatch ? groupMatch[1] : 'Other Channels';
          
          genres.add(group);
          
          const uniqueId = `tv|${tvgId}_${urlIndex}`;
          
          currentChannel = {
            id: uniqueId,
            name: name,
            tvgId: tvgId,
            logo: logo,
            group: group,
            sourceIndex: urlIndex,
            streamInfo: { urls: [], tvg: { id: tvgId, name: name } }
          };
        } else if (line && (line.startsWith('http') || line.startsWith('rtmp')) && currentChannel) {
          currentChannel.streamInfo.urls.push({
            url: line,
            name: currentChannel.name,
            headers: { 'User-Agent': 'Mozilla/5.0' }
          });
          channels.push(currentChannel);
          channelCount++;
          currentChannel = null;
          
          if (channels.length >= cache.maxChannels) {
            console.log('⚠️ Hit channel limit, stopping...');
            break;
          }
        }
      }
      
      console.log(`✅ Parsed ${channelCount} channels from source ${urlIndex + 1}`);
      
    } catch (error) {
      console.error(`❌ Error parsing M3U ${urlIndex + 1}:`, url.substring(0, 50), error.message);
    }
    
    // Free memory between sources
    if (global.gc) global.gc();
  }
  
  console.log(`🎯 Total channels: ${channels.length}, Genres: ${genres.size}`);
  return { channels, genres: Array.from(genres) };
}

// EPG Parser - Optimized with better memory handling
async function parseEPG(epgUrl) {
  if (!epgUrl) return null;
  
  let cleanUrl = epgUrl;
  try {
    while (cleanUrl.includes('%')) {
      const newDecoded = decodeURIComponent(cleanUrl);
      if (newDecoded === cleanUrl) break;
      cleanUrl = newDecoded;
    }
  } catch (e) {
    console.log('EPG URL decode error:', e.message);
  }
  
  console.log('📺 Loading EPG from:', cleanUrl);
  
  try {
    const headResponse = await axios.head(cleanUrl, { timeout: 10000 });
    const contentLength = parseInt(headResponse.headers['content-length'] || '0');
    
    if (contentLength > 100 * 1024 * 1024) {
      console.log(`⚠️ EPG file too large: ${Math.round(contentLength/1024/1024)}MB, skipping`);
      return null;
    }
    
    console.log(`📊 EPG file size: ${Math.round(contentLength/1024/1024)}MB`);
    
    const response = await axios.get(cleanUrl, { 
      responseType: 'stream',
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      maxRedirects: 3,
      validateStatus: (status) => status < 400
    });
    
    return new Promise((resolve, reject) => {
      const chunks = [];
      let totalSize = 0;
      const maxSize = 50 * 1024 * 1024; // 50MB max
      
      let stream = response.data;
      
      if (cleanUrl.endsWith('.gz') || response.headers['content-encoding'] === 'gzip') {
        console.log('🗜️ Streaming gzip decompression...');
        stream = stream.pipe(zlib.createGunzip());
      }
      
      stream.on('data', (chunk) => {
        totalSize += chunk.length;
        
        if (totalSize > maxSize) {
          console.log('⚠️ EPG too large for memory, truncating...');
          stream.destroy();
          return;
        }
        
        chunks.push(chunk);
      });
      
      stream.on('end', async () => {
        try {
          if (chunks.length === 0) {
            console.log('❌ No EPG data received');
            resolve(null);
            return;
          }
          
          const xmlContent = Buffer.concat(chunks).toString();
          console.log('✅ EPG loaded, size:', Math.round(xmlContent.length/1024/1024) + 'MB');
          
          const parsed = await parseStringPromise(xmlContent, {
            trim: true,
            normalize: true,
            explicitArray: false,
            mergeAttrs: true,
            ignoreAttrs: false
          });
          
          chunks.length = 0;
          if (global.gc) global.gc();
          
          console.log('📊 EPG programmes:', parsed.tv?.programme?.length || 0);
          resolve(parsed);
        } catch (parseError) {
          console.error('❌ EPG parse error:', parseError.message);
          resolve(null);
        }
      });
      
      stream.on('error', (error) => {
        console.error('❌ EPG stream error:', error.message);
        resolve(null);
      });
      
      setTimeout(() => {
        stream.destroy();
        console.log('❌ EPG stream timeout');
        resolve(null);
      }, 45000);
    });
    
  } catch (error) {
    console.error('❌ EPG parse error:', error.message);
    return null;
  }
}

// Get current program
function getCurrentProgram(channelId, epgData) {
  if (!epgData || !epgData.tv || !epgData.tv.programme) return null;
  
  const now = new Date();
  const normalizedId = channelId.toLowerCase().replace(/[^\w.]/g, '');
  
  const programmes = Array.isArray(epgData.tv.programme) ? epgData.tv.programme : [epgData.tv.programme];
  
  for (const program of programmes) {
    if (!program.$) continue;
    
    const programChannelId = program.$.channel?.toLowerCase().replace(/[^\w.]/g, '');
    
    if (programChannelId === normalizedId) {
      const start = parseEPGDate(program.$.start);
      const stop = parseEPGDate(program.$.stop);
      
      if (start && stop && start <= now && stop >= now) {
        return {
          title: getTextContent(program.title),
          description: getTextContent(program.desc),
          start: start.toLocaleTimeString(),
          stop: stop.toLocaleTimeString()
        };
      }
    }
  }
  return null;
}

function parseEPGDate(dateString) {
  if (!dateString) return null;
  try {
    const match = dateString.match(/^(\d{14})/);
    if (!match) return null;
    const d = match[1];
    return new Date(
      parseInt(d.substr(0,4)), parseInt(d.substr(4,2))-1, parseInt(d.substr(6,2)),
      parseInt(d.substr(8,2)), parseInt(d.substr(10,2)), parseInt(d.substr(12,2))
    );
  } catch (e) {
    return null;
  }
}

function getTextContent(element) {
  if (!element) return '';
  if (Array.isArray(element) && element.length > 0) {
    return typeof element[0] === 'string' ? element[0] : element[0]._ || '';
  }
  if (typeof element === 'string') return element;
  if (element._) return element._;
  return '';
}

// Parse update interval
function parseUpdateInterval(intervalStr) {
  if (!intervalStr) return 2 * 60 * 60 * 1000; // 2 hours default
  
  const parts = intervalStr.split(':');
  if (parts.length === 2) {
    const hours = parseInt(parts[0]) || 2;
    const minutes = parseInt(parts[1]) || 0;
    return (hours * 60 + minutes) * 60 * 1000;
  }
  
  return 2 * 60 * 60 * 1000;
}

// Routes
app.get('/', (req, res) => {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OMG TV Slim</title>
<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
  color: #e8e8e8;
  background: #1a1a1a;
  min-height: 100vh;
  overflow-x: hidden;
}

#background-video {
  position: fixed;
  right: 0;
  bottom: 0;
  min-width: 100%;
  min-height: 100%;
  width: auto;
  height: auto;
  z-index: -1000;
  background: black;
  object-fit: cover;
  filter: blur(5px) brightness(0.5);
}

.container {
  position: relative;
  max-width: 700px;
  margin: 0 auto;
  padding: 40px 20px;
  background: rgba(0,0,0,0.6);
  backdrop-filter: blur(10px);
  min-height: 100vh;
}

h1 {
  font-size: 2.5em;
  margin-bottom: 10px;
  text-align: center;
  color: #fff;
  text-shadow: 2px 2px 4px rgba(0,0,0,0.5);
}

.version {
  text-align: center;
  color: #999;
  margin-bottom: 30px;
  font-size: 0.9em;
}

.help {
  background: rgba(255,255,255,0.1);
  padding: 15px;
  border-radius: 8px;
  margin-bottom: 20px;
  border-left: 4px solid #3a4556;
}

.help strong {
  display: block;
  margin-bottom: 5px;
  color: #fff;
}

.help small {
  color: #aaa;
  font-size: 0.85em;
}

.form-group {
  margin-bottom: 20px;
}

label {
  display: block;
  margin-bottom: 8px;
  color: #e8e8e8;
  font-weight: 500;
}

input, textarea {
  width: 100%;
  padding: 12px;
  border: 1px solid #555;
  border-radius: 6px;
  background: #2a2a2a;
  color: #e8e8e8;
  font-family: inherit;
  font-size: 14px;
  transition: border-color 0.3s;
}

input:focus, textarea:focus {
  outline: none;
  border-color: #4a5568;
}

textarea {
  height: 120px;
  font-family: 'Courier New', monospace;
  font-size: 13px;
  resize: vertical;
}

button {
  width: 100%;
  background: #3a4556;
  color: #f0f0f0;
  border: none;
  padding: 14px 24px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 16px;
  font-weight: 500;
  transition: background 0.3s;
}

button:hover {
  background: #4a5568;
}

button:active {
  transform: translateY(1px);
}

.result {
  margin-top: 30px;
  padding: 20px;
  background: rgba(0,255,0,0.1);
  border-radius: 8px;
  border: 1px solid rgba(0,255,0,0.3);
  display: none;
  animation: slideIn 0.3s ease;
}

@keyframes slideIn {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.result h3 {
  color: #4CAF50;
  margin-bottom: 15px;
}

.url-box {
  background: rgba(0,0,0,0.4);
  padding: 15px;
  border-radius: 6px;
  font-family: 'Courier New', monospace;
  word-break: break-all;
  margin: 15px 0;
  font-size: 12px;
  color: #fff;
  border: 1px solid #555;
}

.stats {
  margin-top: 30px;
  padding: 15px;
  background: rgba(255,255,255,0.05);
  border-radius: 8px;
  text-align: center;
}

.stats h3 {
  margin-bottom: 10px;
  color: #fff;
}

.stat-item {
  display: inline-block;
  margin: 5px 15px;
  color: #aaa;
}

.stat-value {
  color: #4CAF50;
  font-weight: bold;
}

.footer {
  margin-top: 40px;
  text-align: center;
  color: #777;
  font-size: 0.85em;
}

.footer a {
  color: #7a8ea0;
  text-decoration: none;
}

.footer a:hover {
  color: #9aafbf;
  text-decoration: underline;
}

@media (max-width: 768px) {
  .container {
    padding: 20px 15px;
  }
  
  h1 {
    font-size: 2em;
  }
}
</style>
</head>
<body>
<video autoplay loop muted playsinline id="background-video">
  <source src="https://static.vecteezy.com/system/resources/previews/001/803/236/mp4/no-signal-bad-tv-free-video.mp4" type="video/mp4">
</video>

<div class="container">
  <h1>🎬 OMG TV Slim</h1>
  <div class="version">Lightweight IPTV Addon v1.0.0</div>
  
  <div class="help">
    <strong>📋 Multiple M3U URLs</strong>
    <small>Separate multiple playlist URLs with commas</small><br><br>
    <strong>⏰ Update Interval</strong>
    <small>Format HH:MM (e.g., 12:00 for 12 hours, 02:00 for 2 hours)</small><br><br>
    <strong>📺 EPG Support</strong>
    <small>Supports .xml and .xml.gz formats</small>
  </div>
  
  <form id="form">
    <div class="form-group">
      <label for="m3u">M3U Playlist URLs *</label>
      <textarea id="m3u" placeholder="Enter one or more M3U URLs (comma-separated)&#10;Example:&#10;https://example.com/playlist1.m3u,&#10;https://example.com/playlist2.m3u8" required></textarea>
    </div>
    
    <div class="form-group">
      <label for="epg">EPG Guide URL (Optional)</label>
      <input type="url" id="epg" placeholder="https://example.com/epg.xml or epg.xml.gz">
    </div>
    
    <div class="form-group">
      <label for="language">Language</label>
      <input type="text" id="language" placeholder="Default: English" value="English">
    </div>
    
    <div class="form-group">
      <label for="update_interval">Update Interval</label>
      <input type="text" id="update_interval" placeholder="Default: 02:00" value="02:00">
    </div>
    
    <button type="submit">🚀 Generate Addon</button>
  </form>
  
  <div id="result" class="result">
    <h3>✅ Addon Ready!</h3>
    <p>Copy the URL below and add it to Stremio's addon list:</p>
    <div id="url" class="url-box"></div>
    <button onclick="copyUrl()">📋 Copy to Clipboard</button>
  </div>
  
  <div class="stats">
    <h3>📊 Server Stats</h3>
    <div class="stat-item">
      Channels: <span class="stat-value" id="channelCount">0</span>
    </div>
    <div class="stat-item">
      Last Update: <span class="stat-value" id="lastUpdate">Never</span>
    </div>
  </div>
  
  <div class="footer">
    <p>Addon created by McCoy88f</p>
    <p><a href="https://github.com/mccoy88f/OMG-Premium-TV" target="_blank">GitHub Repository</a></p>
  </div>
</div>

<script>
// Load stats
fetch('/health')
  .then(r => r.json())
  .then(data => {
    document.getElementById('channelCount').textContent = data.channels || 0;
    document.getElementById('lastUpdate').textContent = data.lastUpdate 
      ? new Date(data.lastUpdate).toLocaleString() 
      : 'Never';
  })
  .catch(() => {});

document.getElementById('form').onsubmit = function(e) {
  e.preventDefault();
  
  const m3u = document.getElementById('m3u').value.trim();
  const epg = document.getElementById('epg').value.trim();
  const language = document.getElementById('language').value.trim() || 'English';
  const update_interval = document.getElementById('update_interval').value.trim() || '02:00';
  
  const params = new URLSearchParams({m3u, language, update_interval});
  if (epg) { 
    params.set('epg', epg); 
    params.set('epg_enabled', 'true'); 
  }
  
  const url = '${protocol}://${host}/manifest.json?' + params;
  document.getElementById('url').textContent = url;
  document.getElementById('result').style.display = 'block';
  document.getElementById('result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

function copyUrl() {
  const url = document.getElementById('url').textContent;
  navigator.clipboard.writeText(url).then(() => {
    const btn = event.target;
    const originalText = btn.textContent;
    btn.textContent = '✅ Copied!';
    btn.style.background = '#4CAF50';
    setTimeout(() => {
      btn.textContent = originalText;
      btn.style.background = '';
    }, 2000);
  }).catch(() => {
    alert('Please copy the URL manually');
  });
}
</script>
</body>
</html>`);
});

app.get('/manifest.json', async (req, res) => {
  try {
    if (!req.query.m3u) {
      return res.status(400).json({ error: 'M3U URL required' });
    }
    
    console.log('📋 Query params:', JSON.stringify(req.query, null, 2));
    
    const updateInterval = parseUpdateInterval(req.query.update_interval);
    
    // Update cache if needed
    if (cache.m3uUrl !== req.query.m3u || !cache.lastUpdate || 
        Date.now() - cache.lastUpdate > updateInterval) {
      console.log('🔄 Updating cache...');
      const result = await parseM3U(req.query.m3u);
      cache.channels = result.channels;
      cache.genres = result.genres;
      cache.m3uUrl = req.query.m3u;
      cache.lastUpdate = Date.now();
    }
    
    // Load EPG if enabled - with separate caching
    if ((req.query.epg_enabled === 'true' || req.query.epg_enabled === true) && req.query.epg) {
      const epgUpdateInterval = 6 * 60 * 60 * 1000; // EPG refresh every 6 hours
      
      if (!cache.epgLastUpdate || Date.now() - cache.epgLastUpdate > epgUpdateInterval) {
        console.log('📺 Loading EPG data from:', req.query.epg);
        try {
          const epgPromise = parseEPG(req.query.epg);
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('EPG timeout')), 30000)
          );
          
          cache.epgData = await Promise.race([epgPromise, timeoutPromise]);
          cache.epgLastUpdate = Date.now();
          console.log('✅ EPG loaded successfully');
        } catch (epgError) {
          console.error('❌ EPG loading failed:', epgError.message);
          cache.epgData = null;
        }
      } else {
        console.log('📺 Using cached EPG data');
      }
    }
    
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    
    const manifest = {
      ...config.manifest,
      catalogs: [{
        ...config.manifest.catalogs[0],
        extra: [
          { name: 'genre', isRequired: false, options: cache.genres },
          { name: 'search', isRequired: false },
          { name: 'skip', isRequired: false }
        ]
      }],
      behaviorHints: {
        configurable: true,
        configurationURL: `${protocol}://${host}/?${new URLSearchParams(req.query)}`,
        reloadRequired: true
      }
    };
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(manifest);
  } catch (error) {
    console.error('❌ Manifest error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/catalog/:type/:id/:extra?.json', async (req, res) => {
  try {
    let search, genre, skip = 0;
    
    if (req.params.extra) {
      try {
        const decoded = decodeURIComponent(req.params.extra);
        
        if (decoded.startsWith('{') && decoded.endsWith('}')) {
          const parsed = JSON.parse(decoded);
          search = parsed.search;
          genre = parsed.genre;
          skip = parsed.skip || 0;
        } else {
          const params = new URLSearchParams(decoded);
          search = params.get('search');
          genre = params.get('genre');
          skip = parseInt(params.get('skip')) || 0;
        }
      } catch (parseError) {
        console.error('❌ Extra params parse error:', parseError.message);
        search = null;
        genre = null;
        skip = 0;
      }
    }
    
    let filtered = [...cache.channels];
    
    if (search) {
      const term = search.toLowerCase();
      filtered = filtered.filter(ch => ch.name.toLowerCase().includes(term));
    }
    
    if (genre && genre !== 'Other Channels') {
      filtered = filtered.filter(ch => ch.group === genre);
    }
    
    const startIndex = parseInt(skip) || 0;
    const paged = filtered.slice(startIndex, startIndex + 100);
    
    console.log(`📺 Catalog: ${paged.length} channels (${startIndex}-${startIndex + paged.length})`);
    
    const metas = paged.map(channel => {
      let description = `📺 ${channel.name}`;
      if (channel.group) description += `\n🏷️ ${channel.group}`;
      description += `\n📡 Source ${channel.sourceIndex + 1}`;
      
      if (cache.epgData && channel.tvgId) {
        const program = getCurrentProgram(channel.tvgId, cache.epgData);
        if (program) {
          description += `\n\n🔴 NOW: ${program.title}`;
          if (program.description) {
            description += `\n${program.description.substring(0, 100)}`;
          }
          description += `\n⏰ ${program.start} - ${program.stop}`;
        }
      }
      
      return {
        id: channel.id,
        type: 'tv',
        name: channel.name,
        poster: channel.logo || `https://via.placeholder.com/300x450/3a4556/ffffff?text=${encodeURIComponent(channel.name.substring(0, 2))}`,
        description: description,
        genres: [channel.group]
      };
    });
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({ metas });
  } catch (error) {
    console.error('❌ Catalog error:', error);
    res.status(500).json({ metas: [] });
  }
});

app.get('/stream/:type/:id.json', async (req, res) => {
  try {
    const channel = cache.channels.find(ch => ch.id === req.params.id);
    
    if (!channel) {
      return res.json({ streams: [] });
    }
    
    const streams = channel.streamInfo.urls.map((stream, index) => ({
      name: `📺 ${channel.name} [Source ${channel.sourceIndex + 1}]${index > 0 ? ` (${index + 1})` : ''}`,
      title: channel.name,
      url: stream.url
    }));
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json({ streams });
  } catch (error) {
    console.error('❌ Stream error:', error);
    res.status(500).json({ streams: [] });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    channels: cache.channels.length,
    genres: cache.genres.length,
    epgLoaded: !!cache.epgData,
    lastUpdate: cache.lastUpdate ? new Date(cache.lastUpdate).toISOString() : null,
    epgLastUpdate: cache.epgLastUpdate ? new Date(cache.epgLastUpdate).toISOString() : null,
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
});

const PORT = process.env.PORT || 80;
app.listen(PORT, () => {
  console.log(`🎬 OMG TV Slim running on port ${PORT}`);
  console.log(`🌐 Open http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
});
