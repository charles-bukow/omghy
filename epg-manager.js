const axios = require('axios');
const { parseStringPromise } = require('xml2js');

class SimpleEPGManager {
  constructor() {
    this.epgData = null;
    this.lastUpdate = null;
  }

  async loadEPG(epgUrl) {
    try {
      console.log('Loading EPG from:', epgUrl);
      const response = await axios.get(epgUrl, {
        responseType: 'text',
        timeout: 30000
      });
      
      this.epgData = await parseStringPromise(response.data);
      this.lastUpdate = new Date();
      console.log('EPG loaded successfully');
    } catch (error) {
      console.error('Error loading EPG:', error);
    }
  }

  getProgramForChannel(channelId) {
    if (!this.epgData || !this.epgData.tv || !this.epgData.tv.programme) {
      return null;
    }
    
    const normalizedId = channelId.toLowerCase().replace(/[^\w.]/g, '');
    const now = new Date();
    
    for (const program of this.epgData.tv.programme) {
      const programChannelId = program.$.channel ? program.$.channel.toLowerCase().replace(/[^\w.]/g, '') : '';
      
      if (programChannelId === normalizedId) {
        const start = this.parseEPGDate(program.$.start);
        const stop = this.parseEPGDate(program.$.stop);
        
        if (start && stop && start <= now && stop >= now) {
          return {
            title: program.title && program.title[0] ? program.title[0] : 'Unknown',
            description: program.desc && program.desc[0] ? program.desc[0] : '',
            start: start.toLocaleTimeString(),
            stop: stop.toLocaleTimeString()
          };
        }
      }
    }
    
    return null;
  }

  parseEPGDate(dateString) {
    if (!dateString) return null;
    
    try {
      // EPG date format: YYYYMMDDHHMMSS +0000
      const year = parseInt(dateString.substring(0, 4));
      const month = parseInt(dateString.substring(4, 6)) - 1;
      const day = parseInt(dateString.substring(6, 8));
      const hour = parseInt(dateString.substring(8, 10));
      const minute = parseInt(dateString.substring(10, 12));
      const second = parseInt(dateString.substring(12, 14));
      
      return new Date(year, month, day, hour, minute, second);
    } catch (error) {
      console.error('Error parsing EPG date:', error);
      return null;
    }
  }
}

module.exports = new SimpleEPGManager();