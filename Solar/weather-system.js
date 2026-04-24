/**
 * Weather System for Solar Platform
 * Provides weather data (real or simulated) with solar generation impact
 */

class WeatherSystem {
  constructor() {
    this.currentWeather = {
      condition: 'sunny', // sunny, partly-cloudy, cloudy, rainy
      temperature: 28,
      humidity: 60,
      cloudCover: 10, // 0-100%
      windSpeed: 5, // km/h
      uvIndex: 8,
      sunrise: { hour: 6, minute: 30 },
      sunset: { hour: 18, minute: 45 },
      location: 'Off-Grid Rural Area',
      timestamp: Date.now()
    };
    
    this.solarImpact = {
      generationMultiplier: 1.0, // 0-1.0 based on cloud cover
      efficiency: 1.0,
      forecast: []
    };
    
    this.weatherHistory = [];
  }

  /**
   * Get weather from free API (Open-Meteo) - no API key needed
   * Fallback to simulation if offline
   */
  async fetchWeatherData(latitude = -1.2921, longitude = 36.8219) {
    try {
      // Using Open-Meteo (free, no API key required)
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,weather_code,cloud_cover,wind_speed_10m&timezone=Africa/Nairobi`;
      
      const response = await fetch(url, { 
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });
      
      if (!response.ok) throw new Error('Weather API failed');
      
      const data = await response.json();
      this.parseWeatherData(data);
      return this.currentWeather;
    } catch (error) {
      console.warn('Real weather unavailable, using simulation:', error.message);
      this.simulateWeatherData();
      return this.currentWeather;
    }
  }

  parseWeatherData(apiData) {
    const current = apiData.current;
    
    // Parse WMO weather codes to condition
    const weatherCode = current.weather_code;
    this.currentWeather.condition = this.decodeWeatherCode(weatherCode);
    this.currentWeather.temperature = Math.round(current.temperature_2m);
    this.currentWeather.humidity = current.relative_humidity_2m;
    this.currentWeather.cloudCover = current.cloud_cover;
    this.currentWeather.windSpeed = Math.round(current.wind_speed_10m);
    this.currentWeather.timestamp = Date.now();
    
    this.calculateSolarImpact();
  }

  decodeWeatherCode(code) {
    // WMO Weather interpretation codes
    if (code === 0 || code === 1) return 'sunny';
    if (code === 2) return 'partly-cloudy';
    if (code === 3) return 'cloudy';
    if (code >= 45 && code <= 48) return 'foggy';
    if (code >= 51 && code <= 67) return 'rainy';
    if (code >= 71 && code <= 85) return 'snowy';
    if (code >= 80 && code <= 82) return 'rainy';
    if (code >= 85 && code <= 86) return 'snowy';
    if (code >= 90 && code <= 99) return 'thunderstorm';
    return 'cloudy';
  }

  /**
   * Simulate realistic weather patterns for testing
   */
  simulateWeatherData() {
    const now = new Date();
    const hour = now.getHours();
    
    // More realistic weather during certain hours
    let baseCondition = 'sunny';
    
    if (Math.random() < 0.2) {
      baseCondition = ['sunny', 'partly-cloudy', 'cloudy'][Math.floor(Math.random() * 3)];
    }
    
    // Rainy season simulation (April-May, October-November in East Africa)
    const month = now.getMonth();
    if ((month >= 3 && month <= 4) || (month >= 9 && month <= 10)) {
      if (Math.random() < 0.3) baseCondition = 'rainy';
    }
    
    // Temperature cycle (cooler at dawn/dusk, hotter midday)
    const tempCycle = Math.sin((hour - 6) * Math.PI / 12) * 12 + 28;
    
    this.currentWeather = {
      condition: baseCondition,
      temperature: Math.round(tempCycle + (Math.random() * 4 - 2)),
      humidity: 50 + Math.round(Math.random() * 30),
      cloudCover: this.getCloudCoverForCondition(baseCondition),
      windSpeed: 2 + Math.round(Math.random() * 15),
      uvIndex: Math.max(0, Math.round((Math.sin((hour - 6) * Math.PI / 12) * 10))),
      sunrise: { hour: 6, minute: 30 },
      sunset: { hour: 18, minute: 45 },
      location: 'Simulated Rural Area',
      timestamp: Date.now()
    };
    
    this.calculateSolarImpact();
  }

  getCloudCoverForCondition(condition) {
    const cloudMap = {
      'sunny': Math.random() * 10,
      'partly-cloudy': 30 + Math.random() * 30,
      'cloudy': 60 + Math.random() * 30,
      'rainy': 80 + Math.random() * 15,
      'foggy': 70 + Math.random() * 20,
      'thunderstorm': 90 + Math.random() * 10
    };
    return Math.round(cloudMap[condition] || 50);
  }

  /**
   * Calculate solar generation impact based on weather
   */
  calculateSolarImpact() {
    const cloudCover = this.currentWeather.cloudCover;
    
    // Cloud cover reduces generation efficiency
    // 0% clouds = 100% efficiency
    // 50% clouds = ~60% efficiency
    // 100% clouds = ~5% efficiency
    this.solarImpact.generationMultiplier = Math.max(0.05, 1 - (cloudCover / 100) * 0.95);
    
    // Adjust for weather condition
    const conditionFactors = {
      'sunny': 1.0,
      'partly-cloudy': 0.75,
      'cloudy': 0.35,
      'rainy': 0.10,
      'foggy': 0.15,
      'snowy': 0.20,
      'thunderstorm': 0.05
    };
    
    this.solarImpact.efficiency = conditionFactors[this.currentWeather.condition] || 0.5;
    
    // Combine factors
    this.solarImpact.generationMultiplier = 
      (this.solarImpact.generationMultiplier + this.solarImpact.efficiency) / 2;
    
    // Store in history
    this.weatherHistory.push({
      timestamp: this.currentWeather.timestamp,
      condition: this.currentWeather.condition,
      multiplier: this.solarImpact.generationMultiplier
    });
    
    if (this.weatherHistory.length > 288) {
      this.weatherHistory.shift();
    }
  }

  /**
   * Get weather impact message for UI
   */
  getImpactMessage() {
    const mult = this.solarImpact.generationMultiplier;
    
    if (mult >= 0.9) return '☀️ Excellent solar conditions - peak generation';
    if (mult >= 0.75) return '🌤️ Good solar conditions - strong generation';
    if (mult >= 0.5) return '⛅ Moderate solar conditions - decent generation';
    if (mult >= 0.25) return '☁️ Poor solar conditions - reduced generation';
    return '🌧️ Very poor conditions - minimal generation';
  }

  /**
   * Simulate sun position for visual animation
   */
  getSunPosition() {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    const totalMinutes = hour * 60 + minute;
    
    const sunrise = 6 * 60 + 30; // 6:30 AM
    const sunset = 18 * 60 + 45; // 6:45 PM
    
    if (totalMinutes < sunrise || totalMinutes > sunset) {
      return { visible: false, angle: 0 };
    }
    
    // Calculate sun angle (0-180 degrees across the sky)
    const sunDayLength = sunset - sunrise;
    const sunProgress = (totalMinutes - sunrise) / sunDayLength;
    const angle = sunProgress * 180;
    
    return {
      visible: true,
      angle: angle,
      altitude: Math.sin((angle * Math.PI) / 180) * 100 // 0-100% height
    };
  }

  /**
   * Get wind direction emoji
   */
  getWindDirection() {
    const directions = ['↑ N', '↗ NE', '→ E', '↘ SE', '↓ S', '↙ SW', '← W', '↖ NW'];
    const randomDir = Math.floor(Math.random() * 8);
    return directions[randomDir];
  }

  /**
   * Get appropriate background class for CSS styling
   */
  getBackgroundClass() {
    const condition = this.currentWeather.condition;
    const hour = new Date().getHours();
    
    if (hour < 6 || hour >= 19) return 'weather-night';
    if (condition === 'sunny') return 'weather-sunny';
    if (condition === 'partly-cloudy') return 'weather-partly-cloudy';
    if (condition === 'cloudy') return 'weather-cloudy';
    if (condition === 'rainy') return 'weather-rainy';
    if (condition === 'thunderstorm') return 'weather-thunderstorm';
    
    return 'weather-cloudy';
  }

  /**
   * Get color theme for current weather
   */
  getWeatherTheme() {
    return {
      primary: this.getBackgroundClass(),
      skyColor: this.getSkyColor(),
      textColor: this.getTextColor()
    };
  }

  getSkyColor() {
    const colors = {
      'weather-night': '#0a1628',
      'weather-sunny': '#87CEEB',
      'weather-partly-cloudy': '#6BA3D0',
      'weather-cloudy': '#4A7BA7',
      'weather-rainy': '#2C3E50',
      'weather-thunderstorm': '#1A252F'
    };
    return colors[this.getBackgroundClass()];
  }

  getTextColor() {
    const bg = this.getBackgroundClass();
    if (bg === 'weather-night' || bg === 'weather-thunderstorm') return '#f0f0f0';
    return '#ffffff';
  }

  /**
   * Generate hourly weather forecast
   */
  generateForecast(hours = 12) {
    const forecast = [];
    const baseCondition = this.currentWeather.condition;
    
    for (let i = 1; i <= hours; i++) {
      const conditionVariance = Math.random();
      let condition = baseCondition;
      
      if (conditionVariance > 0.8) {
        condition = ['sunny', 'partly-cloudy', 'cloudy'][Math.floor(Math.random() * 3)];
      }
      
      const tempVariance = Math.sin((i / hours) * Math.PI) * 8;
      const temperature = this.currentWeather.temperature + tempVariance + (Math.random() * 3 - 1.5);
      
      forecast.push({
        hour: i,
        condition: condition,
        temperature: Math.round(temperature),
        cloudCover: this.getCloudCoverForCondition(condition),
        generationMultiplier: this.calculateMultiplier(condition)
      });
    }
    
    return forecast;
  }

  calculateMultiplier(condition) {
    const factors = {
      'sunny': 1.0,
      'partly-cloudy': 0.75,
      'cloudy': 0.35,
      'rainy': 0.10
    };
    return factors[condition] || 0.5;
  }
}

// Export singleton
const weatherSystem = new WeatherSystem();

export default weatherSystem;
