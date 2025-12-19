const axios = require('axios');

class SimpleM3UParser {
  async parseM3U(url) {
    try {
      const response = await axios.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 30000
      });
      
      const lines = response.data.split('\n');
      const channels = [];
      let currentChannel = null;
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        if (line.startsWith('#EXTINF:')) {
          const metadata = line.substring(8).trim();
          
          // Extract name
          const nameMatch = metadata.match(/,(.*)$/);
          const name = nameMatch ? nameMatch[1].trim() : 'Unknown Channel';
          
          // Extract tvg-id
          const tvgIdMatch = metadata.match(/tvg-id="([^"]+)"/);
          const tvgId = tvgIdMatch ? tvgIdMatch[1] : null;
          
          // Extract logo
          const logoMatch = metadata.match(/tvg-logo="([^"]+)"/);
          const logo = logoMatch ? logoMatch[1] : null;
          
          // Extract group
          const groupMatch = metadata.match(/group-title="([^"]+)"/);
          const group = groupMatch ? groupMatch[1] : 'General';
          
          currentChannel = {
            id: `tv|${tvgId || name.toLowerCase().replace(/[^\w]/g, '_')}`,
            name,
            tvgId,
            logo,
            group
          };
        } else if (line && line.startsWith('http') && currentChannel) {
          currentChannel.url = line;
          channels.push(currentChannel);
          currentChannel = null;
        }
      }
      
      return channels;
    } catch (error) {
      console.error('Error parsing M3U:', error);
      return [];
    }
  }
}

module.exports = new SimpleM3UParser();