/**
 * Solar Panel Configuration & Compatibility Module
 * Handles multi-panel setups and validates sensor data
 */

const panelDatabase = {
  // Monocrystalline panels (highest efficiency ~21-22%)
  'Monocrystalline_400W': {
    type: 'Monocrystalline',
    nominalPower: 400,
    maxVoltage: 48,
    maxCurrent: 8.3,
    efficiency: 0.21,
    temperatureCoefficient: -0.004,  // -0.4% per °C
    idealTemperature: 25,
    description: 'Premium efficiency panel, best for limited space'
  },
  
  // Polycrystalline panels (medium efficiency ~16-18%)
  'Polycrystalline_300W': {
    type: 'Polycrystalline',
    nominalPower: 300,
    maxVoltage: 48,
    maxCurrent: 6.2,
    efficiency: 0.17,
    temperatureCoefficient: -0.005,
    idealTemperature: 25,
    description: 'Cost-effective, good durability'
  },
  
  // Thin-film panels (lower efficiency ~10-12%)
  'Thin_Film_250W': {
    type: 'Thin-Film',
    nominalPower: 250,
    maxVoltage: 48,
    maxCurrent: 5.2,
    efficiency: 0.11,
    temperatureCoefficient: -0.002,
    idealTemperature: 25,
    description: 'Best low-light performance, cheaper'
  },
  
  // Bifacial panels (higher output ~450W)
  'Bifacial_450W': {
    type: 'Bifacial',
    nominalPower: 450,
    maxVoltage: 48,
    maxCurrent: 9.4,
    efficiency: 0.22,
    temperatureCoefficient: -0.003,
    idealTemperature: 25,
    description: 'Captures light from both sides, ideal for reflective surfaces'
  },
  
  // Half-cell panels (380W with better performance)
  'Half_Cell_380W': {
    type: 'Half-Cell',
    nominalPower: 380,
    maxVoltage: 48,
    maxCurrent: 7.9,
    efficiency: 0.2,
    temperatureCoefficient: -0.004,
    idealTemperature: 25,
    description: 'Reduces hotspots, better performance at partial shading'
  }
};

/**
 * Panel Compatibility Validator
 */
class PanelCompatibility {
  constructor(panelType = 'Monocrystalline_400W') {
    this.panelType = panelType;
    this.config = panelDatabase[panelType];
    
    if (!this.config) {
      throw new Error(`Unknown panel type: ${panelType}`);
    }
    
    this.readingHistory = [];
    this.anomalyCount = 0;
  }

  /**
   * Validate sensor readings against panel specifications
   */
  validateReading(voltage, current, temperature = 25) {
    const issues = [];
    
    // Voltage check
    if (voltage > this.config.maxVoltage) {
      issues.push({
        type: 'OVERVOLTAGE',
        severity: 'high',
        message: `Voltage ${voltage}V exceeds max ${this.config.maxVoltage}V`,
        recommendation: 'Check charge controller settings, may damage battery'
      });
    }
    
    if (voltage < 20) {
      issues.push({
        type: 'UNDERVOLTAGE',
        severity: 'warning',
        message: `Voltage ${voltage}V is critically low`,
        recommendation: 'System may shut down if voltage drops further'
      });
    }
    
    // Current check
    if (current > this.config.maxCurrent) {
      issues.push({
        type: 'OVERCURRENT',
        severity: 'high',
        message: `Current ${current}A exceeds max ${this.config.maxCurrent}A`,
        recommendation: 'Check for short circuits or damaged wiring'
      });
    }
    
    // Power calculation
    const measuredPower = voltage * current;
    const theoreticalMax = this.config.nominalPower;
    const temperatureAdjustedMax = theoreticalMax * 
      (1 + this.config.temperatureCoefficient * (temperature - this.config.idealTemperature));
    
    // eslint-disable-next-line no-undef
    if (measuredPower > tempereticalMax + 50) {
      issues.push({
        type: 'POWER_ANOMALY',
        severity: 'warning',
        message: `Measured power ${measuredPower}W exceeds nominal ${theoreticalMax}W`,
        recommendation: 'Sensor calibration may be off'
      });
    }
    
    // Temperature effect
    if (temperature > 60) {
      issues.push({
        type: 'HIGH_TEMPERATURE',
        severity: 'warning',
        message: `Panel temperature ${temperature}°C is high, efficiency reduced`,
        expectedEfficiency: 
          this.config.efficiency * (1 + this.config.temperatureCoefficient * (temperature - this.config.idealTemperature)),
        recommendation: 'Ensure proper ventilation, clean panels'
      });
    }
    
    return {
      isValid: issues.length === 0,
      issues,
      panelType: this.panelType,
      panelConfig: this.config,
      measuredPower,
      maxPower: temperatureAdjustedMax
    };
  }

  /**
   * Detect common panel faults
   */
  detectFaults(voltage, current, efficiency) {
    const faults = [];
    const expectedPower = this.config.nominalPower * 0.8;  // Account for non-ideal conditions
    const measuredPower = voltage * current;
    
    // Panel dust/dirt
    if (measuredPower < expectedPower * 0.6 && efficiency < 0.5) {
      faults.push({
        type: 'PANEL_DUST',
        severity: 'medium',
        message: 'Severe power loss detected, likely dust/dirt on panels',
        recommendation: 'Clean panel surface with soft brush and deionized water'
      });
    }
    
    // Panel degradation
    if (measuredPower < expectedPower * 0.5) {
      faults.push({
        type: 'PANEL_DEGRADATION',
        severity: 'high',
        message: 'Panel power below 50% of nominal - possible defect',
        recommendation: 'Have panel tested or replaced'
      });
    }
    
    // Wiring issues (voltage drop)
    const expectedVoltage = measuredPower / current;
    if (voltage < expectedVoltage * 0.95 && voltage > 30) {
      faults.push({
        type: 'WIRING_LOSS',
        severity: 'medium',
        message: `Voltage drop indicates wiring resistance (expected ${expectedVoltage}V, got ${voltage}V)`,
        recommendation: 'Check for loose connections, corroded terminals, or undersized wire'
      });
    }
    
    // Shading detection
    if (measuredPower > 0 && measuredPower < expectedPower * 0.3) {
      faults.push({
        type: 'PARTIAL_SHADING',
        severity: 'low',
        message: 'Low power output - panels may be partially shaded',
        recommendation: 'Remove obstacles or reposition panels for better sun exposure'
      });
    }
    
    return faults;
  }

  /**
   * Get temperature-adjusted expected power
   */
  getTemperatureAdjustedPower(temperature) {
    return this.config.nominalPower * 
      (1 + this.config.temperatureCoefficient * (temperature - this.config.idealTemperature));
  }

  /**
   * Estimate daily energy generation based on sun hours
   */
  estimateDailyEnergy(sunHours = 5) {
    // Assumes average insolation of 1000W/m² for full sun hour
    return this.config.nominalPower * sunHours * this.config.efficiency;
  }

  /**
   * Recommend optimal load shift times (peak generation)
   */
  getOptimalLoadTimes() {
    return {
      peakHours: ['9:00-11:00', '12:00-14:00'],  // Typical peak solar hours
      description: 'Best times for energy-intensive tasks (washing, cooking, charging)',
      expectedGeneration: 'Peak generation ~90% of nominal power'
    };
  }

  /**
   * Get maintenance schedule recommendations
   */
  getMaintenanceSchedule() {
    return {
      weekly: [
        { task: 'Visual inspection for debris/dust', time: '10 mins' },
        { task: 'Check for bird droppings or leaves', time: '5 mins' }
      ],
      monthly: [
        { task: 'Clean panel surface with soft cloth and deionized water', time: '30 mins' },
        { task: 'Check mounting structure for corrosion', time: '10 mins' },
        { task: 'Verify all electrical connections are tight', time: '15 mins' }
      ],
      quarterly: [
        { task: 'Professional panel cleaning (if in dusty area)', time: '1 hour' },
        { task: 'Thermal imaging inspection', time: '30 mins' },
        { task: 'Check inverter/charge controller performance', time: '20 mins' }
      ],
      annually: [
        { task: 'Full professional inspection', time: '2 hours' },
        { task: 'IV curve testing', time: '1 hour' },
        { task: 'Check grounding and safety systems', time: '1 hour' }
      ]
    };
  }
}

/**
 * Multi-Panel Configuration Manager
 */
class MultiPanelSetup {
  constructor() {
    this.panels = [];
    this.totalPower = 0;
    this.configuration = 'series';  // 'series', 'parallel', or 'hybrid'
  }

  /**
   * Add panel to setup
   */
  addPanel(panelType, quantity = 1) {
    const config = panelDatabase[panelType];
    if (!config) throw new Error(`Unknown panel type: ${panelType}`);
    
    this.panels.push({
      type: panelType,
      quantity,
      config,
      totalPower: config.nominalPower * quantity
    });
    
    this.calculateTotalPower();
  }

  /**
   * Calculate total system power
   */
  calculateTotalPower() {
    if (this.configuration === 'series') {
      // Series: voltages add, current same
      this.totalVoltage = this.panels.reduce((sum, p) => sum + (p.config.maxVoltage / p.quantity), 0);
      this.totalCurrent = Math.min(...this.panels.map(p => p.config.maxCurrent));
    } else if (this.configuration === 'parallel') {
      // Parallel: voltage same, currents add
      this.totalVoltage = this.panels[0]?.config.maxVoltage || 48;
      this.totalCurrent = this.panels.reduce((sum, p) => sum + (p.config.maxCurrent * p.quantity), 0);
    }
    
    this.totalPower = this.panels.reduce((sum, p) => sum + p.totalPower, 0);
  }

  /**
   * Get system specifications
   */
  getSystemSpecs() {
    return {
      totalPanels: this.panels.reduce((sum, p) => sum + p.quantity, 0),
      totalPower: this.totalPower,
      maxVoltage: this.totalVoltage,
      maxCurrent: this.totalCurrent,
      configuration: this.configuration,
      panels: this.panels.map(p => ({
        type: p.type,
        quantity: p.quantity,
        individualPower: p.config.nominalPower,
        totalPower: p.totalPower
      }))
    };
  }
}

// Export for use in server
export { PanelCompatibility, MultiPanelSetup, panelDatabase };
