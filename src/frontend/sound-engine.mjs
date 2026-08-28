// Direct production extraction of the nine procedural Web Audio recipes from the approved prototype app.js.
// This module contains no prototype state, data handlers, or rendering runtime.

  const SoundEngine = (() => {
    let ctx = null;
    let masterGain = null;
    let compressor = null;

    function getContext() {
      if (!ctx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
          ctx = new AudioCtx();
        }
      }
      if (ctx && ctx.state === "suspended") {
        ctx.resume();
      }
      return ctx;
    }

    function getMaster(c) {
      if (!masterGain) {
        compressor = c.createDynamicsCompressor();
        compressor.threshold.setValueAtTime(-16, c.currentTime);
        compressor.knee.setValueAtTime(24, c.currentTime);
        compressor.ratio.setValueAtTime(6, c.currentTime);
        compressor.attack.setValueAtTime(0.003, c.currentTime);
        compressor.release.setValueAtTime(0.2, c.currentTime);

        masterGain = c.createGain();
        masterGain.gain.setValueAtTime(0.42, c.currentTime);

        masterGain.connect(compressor);
        compressor.connect(c.destination);
      }
      return masterGain;
    }

    function playTrimSound(c, out, theme) {
      const t = c.currentTime;

      if (theme === "brass") {
        // 1. Brass: Warm clockwork brass gear escapement micro-tooth tick
        const osc1 = c.createOscillator();
        const osc2 = c.createOscillator();
        const filter = c.createBiquadFilter();
        const gain = c.createGain();

        filter.type = "lowpass";
        filter.frequency.setValueAtTime(650, t);

        osc1.type = "sine";
        osc1.frequency.setValueAtTime(360, t);
        osc1.frequency.exponentialRampToValueAtTime(180, t + 0.025);

        osc2.type = "triangle";
        osc2.frequency.setValueAtTime(720, t);
        osc2.frequency.exponentialRampToValueAtTime(240, t + 0.02);

        gain.gain.setValueAtTime(0.15, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.03);

        osc1.connect(filter);
        osc2.connect(filter);
        filter.connect(gain);
        gain.connect(out);

        osc1.start(t);
        osc2.start(t);
        osc1.stop(t + 0.035);
        osc2.stop(t + 0.035);
      } else if (theme === "ticket") {
        // 2. Ticket: Soft card flick & perforation tactile slip
        const bufferSize = Math.floor(c.sampleRate * 0.015);
        const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * 0.3;

        const noise = c.createBufferSource();
        noise.buffer = buffer;
        const filter = c.createBiquadFilter();
        filter.type = "bandpass";
        filter.frequency.setValueAtTime(540, t);
        filter.Q.setValueAtTime(3.5, t);

        const nGain = c.createGain();
        nGain.gain.setValueAtTime(0.18, t);
        nGain.gain.exponentialRampToValueAtTime(0.001, t + 0.018);

        const thud = c.createOscillator();
        const tGain = c.createGain();
        thud.type = "sine";
        thud.frequency.setValueAtTime(240, t);
        thud.frequency.exponentialRampToValueAtTime(90, t + 0.02);
        tGain.gain.setValueAtTime(0.16, t);
        tGain.gain.exponentialRampToValueAtTime(0.001, t + 0.02);

        noise.connect(filter);
        filter.connect(nGain);
        nGain.connect(out);
        thud.connect(tGain);
        tGain.connect(out);

        noise.start(t);
        thud.start(t);
        noise.stop(t + 0.02);
        thud.stop(t + 0.025);
      } else if (theme === "proof") {
        // 3. Proof: Letterpress cylinder felt damper micro-tap
        const osc = c.createOscillator();
        const filter = c.createBiquadFilter();
        const gain = c.createGain();

        filter.type = "lowpass";
        filter.frequency.setValueAtTime(480, t);

        osc.type = "triangle";
        osc.frequency.setValueAtTime(260, t);
        osc.frequency.exponentialRampToValueAtTime(110, t + 0.03);

        gain.gain.setValueAtTime(0.2, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.035);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(out);

        osc.start(t);
        osc.stop(t + 0.04);
      } else if (theme === "fold") {
        // 4. Fold: Organic delicate origami paper fold & golden foil friction
        const osc = c.createOscillator();
        const filter = c.createBiquadFilter();
        const gain = c.createGain();

        filter.type = "bandpass";
        filter.frequency.setValueAtTime(1100, t);
        filter.Q.setValueAtTime(4.0, t);

        osc.type = "sine";
        osc.frequency.setValueAtTime(820, t);
        osc.frequency.exponentialRampToValueAtTime(410, t + 0.03);

        gain.gain.setValueAtTime(0.12, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.035);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(out);

        osc.start(t);
        osc.stop(t + 0.04);
      } else if (theme === "strata") {
        // 5. Strata: Crystal glass sonar micro-ping (Pure musical fifth)
        const osc1 = c.createOscillator();
        const osc2 = c.createOscillator();
        const gain = c.createGain();

        osc1.type = "sine";
        osc1.frequency.setValueAtTime(523.25, t); // C5
        osc1.frequency.exponentialRampToValueAtTime(261.63, t + 0.035);

        osc2.type = "sine";
        osc2.frequency.setValueAtTime(783.99, t); // G5
        osc2.frequency.exponentialRampToValueAtTime(392.00, t + 0.03);

        gain.gain.setValueAtTime(0.09, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.038);

        osc1.connect(gain);
        osc2.connect(gain);
        gain.connect(out);

        osc1.start(t);
        osc2.start(t);
        osc1.stop(t + 0.04);
        osc2.stop(t + 0.04);
      } else if (theme === "signal") {
        // 6. Signal: Broadcast master console magnetic tape head low flutter
        const osc = c.createOscillator();
        const filter = c.createBiquadFilter();
        const gain = c.createGain();

        filter.type = "lowpass";
        filter.frequency.setValueAtTime(320, t);

        osc.type = "sine";
        osc.frequency.setValueAtTime(130, t);
        osc.frequency.exponentialRampToValueAtTime(55, t + 0.03);

        gain.gain.setValueAtTime(0.24, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.035);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(out);

        osc.start(t);
        osc.stop(t + 0.04);
      } else if (theme === "celadon") {
        // 7. Celadon: Water drop on jade porcelain chime (Gentle acoustic chime)
        const osc1 = c.createOscillator();
        const osc2 = c.createOscillator();
        const gain = c.createGain();

        osc1.type = "sine";
        osc1.frequency.setValueAtTime(698.46, t); // F5
        osc1.frequency.exponentialRampToValueAtTime(349.23, t + 0.04);

        osc2.type = "sine";
        osc2.frequency.setValueAtTime(1396.91, t); // F6 overtone
        osc2.frequency.exponentialRampToValueAtTime(698.46, t + 0.03);

        gain.gain.setValueAtTime(0.08, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.045);

        osc1.connect(gain);
        osc2.connect(gain);
        gain.connect(out);

        osc1.start(t);
        osc2.start(t);
        osc1.stop(t + 0.05);
        osc2.stop(t + 0.05);
      } else if (theme === "relay") {
        // 8. Relay: Sealed nitrogen miniature reed relay soft micro-click
        [0, 0.008].forEach((dt, idx) => {
          const osc = c.createOscillator();
          const filter = c.createBiquadFilter();
          const gain = c.createGain();

          filter.type = "lowpass";
          filter.frequency.setValueAtTime(580, t + dt);

          osc.type = "triangle";
          osc.frequency.setValueAtTime(idx === 0 ? 380 : 260, t + dt);
          osc.frequency.exponentialRampToValueAtTime(140, t + dt + 0.012);

          gain.gain.setValueAtTime(idx === 0 ? 0.18 : 0.12, t + dt);
          gain.gain.exponentialRampToValueAtTime(0.001, t + dt + 0.014);

          osc.connect(filter);
          filter.connect(gain);
          gain.connect(out);

          osc.start(t + dt);
          osc.stop(t + dt + 0.016);
        });
      } else if (theme === "inkwhite") {
        // 9. Inkwhite: Chinese calligraphy brush ink droplet onto absorbent rice paper
        const osc = c.createOscillator();
        const filter = c.createBiquadFilter();
        const gain = c.createGain();

        filter.type = "lowpass";
        filter.frequency.setValueAtTime(360, t);

        osc.type = "sine";
        osc.frequency.setValueAtTime(240, t);
        osc.frequency.exponentialRampToValueAtTime(75, t + 0.04);

        gain.gain.setValueAtTime(0.22, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.045);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(out);

        osc.start(t);
        osc.stop(t + 0.05);
      }
    }

    const synths = {
      brass: (c, out, type) => {
        const t = c.currentTime;
        if (type === "trim") {
          playTrimSound(c, out, "brass");
        } else if (type === "toggle" || type === "tab") {
          const osc = c.createOscillator();
          const gain = c.createGain();
          const filter = c.createBiquadFilter();
          filter.type = "bandpass";
          filter.frequency.setValueAtTime(1200, t);
          filter.Q.setValueAtTime(2.5, t);
          osc.type = "triangle";
          osc.frequency.setValueAtTime(280, t);
          osc.frequency.exponentialRampToValueAtTime(560, t + 0.04);
          gain.gain.setValueAtTime(0.35, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
          osc.connect(filter);
          filter.connect(gain);
          gain.connect(out);
          osc.start(t);
          osc.stop(t + 0.065);
        } else if (type === "success") {
          [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
            const osc = c.createOscillator();
            const gain = c.createGain();
            const filter = c.createBiquadFilter();
            filter.type = "bandpass";
            filter.frequency.setValueAtTime(freq * 1.3, t);
            filter.Q.setValueAtTime(2, t);
            osc.type = "triangle";
            osc.frequency.setValueAtTime(freq, t + i * 0.04);
            gain.gain.setValueAtTime(0.001, t);
            gain.gain.setValueAtTime(0.24, t + i * 0.04);
            gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.04 + 0.25);
            osc.connect(filter);
            filter.connect(gain);
            gain.connect(out);
            osc.start(t + i * 0.04);
            osc.stop(t + i * 0.04 + 0.28);
          });
        } else {
          const osc1 = c.createOscillator();
          const osc2 = c.createOscillator();
          const gain = c.createGain();
          const filter = c.createBiquadFilter();
          filter.type = "bandpass";
          filter.frequency.setValueAtTime(1800, t);
          filter.Q.setValueAtTime(3, t);
          osc1.type = "sine";
          osc1.frequency.setValueAtTime(600, t);
          osc1.frequency.exponentialRampToValueAtTime(160, t + 0.035);
          osc2.type = "triangle";
          osc2.frequency.setValueAtTime(1400, t);
          osc2.frequency.exponentialRampToValueAtTime(300, t + 0.04);
          gain.gain.setValueAtTime(0.35, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.045);
          osc1.connect(filter);
          osc2.connect(filter);
          filter.connect(gain);
          gain.connect(out);
          osc1.start(t);
          osc2.start(t);
          osc1.stop(t + 0.05);
          osc2.stop(t + 0.05);
        }
      },

      ticket: (c, out, type) => {
        const t = c.currentTime;
        if (type === "trim") {
          playTrimSound(c, out, "ticket");
        } else if (type === "success") {
          [520, 680, 960].forEach((freq, idx) => {
            const osc = c.createOscillator();
            const g = c.createGain();
            osc.type = "sine";
            osc.frequency.setValueAtTime(freq, t + idx * 0.045);
            g.gain.setValueAtTime(0.28, t + idx * 0.045);
            g.gain.exponentialRampToValueAtTime(0.001, t + idx * 0.045 + 0.1);
            osc.connect(g);
            g.connect(out);
            osc.start(t + idx * 0.045);
            osc.stop(t + idx * 0.045 + 0.11);
          });
        } else {
          const osc = c.createOscillator();
          const oGain = c.createGain();
          osc.type = "sine";
          osc.frequency.setValueAtTime(320, t);
          osc.frequency.exponentialRampToValueAtTime(80, t + 0.025);
          oGain.gain.setValueAtTime(0.35, t);
          oGain.gain.exponentialRampToValueAtTime(0.001, t + 0.025);
          osc.connect(oGain);
          oGain.connect(out);
          osc.start(t);
          osc.stop(t + 0.03);
        }
      },

      proof: (c, out, type) => {
        const t = c.currentTime;
        if (type === "trim") {
          playTrimSound(c, out, "proof");
        } else if (type === "success") {
          [660, 990].forEach((freq, idx) => {
            const osc = c.createOscillator();
            const g = c.createGain();
            osc.type = "sine";
            osc.frequency.setValueAtTime(freq, t + idx * 0.05);
            g.gain.setValueAtTime(0.25, t + idx * 0.05);
            g.gain.exponentialRampToValueAtTime(0.001, t + idx * 0.05 + 0.12);
            osc.connect(g);
            g.connect(out);
            osc.start(t + idx * 0.05);
            osc.stop(t + idx * 0.05 + 0.13);
          });
        } else {
          const osc = c.createOscillator();
          const g = c.createGain();
          osc.type = "sine";
          osc.frequency.setValueAtTime(1400, t);
          osc.frequency.exponentialRampToValueAtTime(350, t + 0.02);
          g.gain.setValueAtTime(0.36, t);
          g.gain.exponentialRampToValueAtTime(0.001, t + 0.022);
          osc.connect(g);
          g.connect(out);
          osc.start(t);
          osc.stop(t + 0.025);
        }
      },

      fold: (c, out, type) => {
        const t = c.currentTime;
        if (type === "trim") {
          playTrimSound(c, out, "fold");
        } else {
          const chime = c.createOscillator();
          const chimeGain = c.createGain();
          chime.type = "sine";
          chime.frequency.setValueAtTime(type === "success" ? 1320 : 980, t);
          chime.frequency.exponentialRampToValueAtTime(440, t + 0.04);
          chimeGain.gain.setValueAtTime(0.26, t);
          chimeGain.gain.exponentialRampToValueAtTime(0.001, t + 0.045);
          chime.connect(chimeGain);
          chimeGain.connect(out);
          chime.start(t);
          chime.stop(t + 0.05);
        }
      },

      strata: (c, out, type) => {
        const t = c.currentTime;
        if (type === "trim") {
          playTrimSound(c, out, "strata");
        } else if (type === "success") {
          [880, 1174.66, 1480].forEach((freq, idx) => {
            const osc = c.createOscillator();
            const g = c.createGain();
            osc.type = "sine";
            osc.frequency.setValueAtTime(freq, t + idx * 0.04);
            g.gain.setValueAtTime(0.22, t + idx * 0.04);
            g.gain.exponentialRampToValueAtTime(0.001, t + idx * 0.04 + 0.1);
            osc.connect(g);
            g.connect(out);
            osc.start(t + idx * 0.04);
            osc.stop(t + idx * 0.04 + 0.11);
          });
        } else {
          const osc = c.createOscillator();
          const g = c.createGain();
          osc.type = "sine";
          osc.frequency.setValueAtTime(1100, t);
          osc.frequency.exponentialRampToValueAtTime(440, t + 0.02);
          g.gain.setValueAtTime(0.28, t);
          g.gain.exponentialRampToValueAtTime(0.001, t + 0.022);
          osc.connect(g);
          g.connect(out);
          osc.start(t);
          osc.stop(t + 0.025);
        }
      },

      signal: (c, out, type) => {
        const t = c.currentTime;
        if (type === "trim") {
          playTrimSound(c, out, "signal");
        } else if (type === "success") {
          [440, 554.37, 659.25].forEach((freq, idx) => {
            const osc = c.createOscillator();
            const g = c.createGain();
            osc.type = "sine";
            osc.frequency.setValueAtTime(freq, t + idx * 0.045);
            g.gain.setValueAtTime(0.28, t + idx * 0.045);
            g.gain.exponentialRampToValueAtTime(0.001, t + idx * 0.045 + 0.18);
            osc.connect(g);
            g.connect(out);
            osc.start(t + idx * 0.045);
            osc.stop(t + idx * 0.045 + 0.2);
          });
        } else {
          const osc = c.createOscillator();
          const g = c.createGain();
          osc.type = "sine";
          osc.frequency.setValueAtTime(120, t);
          osc.frequency.exponentialRampToValueAtTime(55, t + 0.035);
          g.gain.setValueAtTime(0.38, t);
          g.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
          osc.connect(g);
          g.connect(out);
          osc.start(t);
          osc.stop(t + 0.045);
        }
      },

      celadon: (c, out, type) => {
        const t = c.currentTime;
        if (type === "trim") {
          playTrimSound(c, out, "celadon");
        } else if (type === "success") {
          [587.33, 659.25, 783.99, 880].forEach((freq, idx) => {
            const osc = c.createOscillator();
            const g = c.createGain();
            osc.type = "sine";
            osc.frequency.setValueAtTime(freq, t + idx * 0.045);
            g.gain.setValueAtTime(0.24, t + idx * 0.045);
            g.gain.exponentialRampToValueAtTime(0.001, t + idx * 0.045 + 0.28);
            osc.connect(g);
            g.connect(out);
            osc.start(t + idx * 0.045);
            osc.stop(t + idx * 0.045 + 0.3);
          });
        } else {
          const osc = c.createOscillator();
          const g = c.createGain();
          osc.type = "sine";
          osc.frequency.setValueAtTime(980, t);
          osc.frequency.exponentialRampToValueAtTime(440, t + 0.04);
          g.gain.setValueAtTime(0.28, t);
          g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
          osc.connect(g);
          g.connect(out);
          osc.start(t);
          osc.stop(t + 0.055);
        }
      },

      relay: (c, out, type) => {
        const t = c.currentTime;
        if (type === "trim") {
          playTrimSound(c, out, "relay");
        } else {
          const osc = c.createOscillator();
          const g = c.createGain();
          osc.type = "triangle";
          osc.frequency.setValueAtTime(480, t);
          osc.frequency.exponentialRampToValueAtTime(180, t + 0.025);
          g.gain.setValueAtTime(0.42, t);
          g.gain.exponentialRampToValueAtTime(0.001, t + 0.028);
          osc.connect(g);
          g.connect(out);
          osc.start(t);
          osc.stop(t + 0.03);
        }
      },

      inkwhite: (c, out, type) => {
        const t = c.currentTime;
        if (type === "trim") {
          playTrimSound(c, out, "inkwhite");
        } else if (type === "success") {
          const osc = c.createOscillator();
          const g = c.createGain();
          osc.type = "sine";
          osc.frequency.setValueAtTime(360, t);
          osc.frequency.exponentialRampToValueAtTime(110, t + 0.08);
          g.gain.setValueAtTime(0.55, t);
          g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
          osc.connect(g);
          g.connect(out);
          osc.start(t);
          osc.stop(t + 0.17);
        } else {
          const strike = c.createOscillator();
          const g = c.createGain();
          strike.type = "sine";
          strike.frequency.setValueAtTime(280, t);
          strike.frequency.exponentialRampToValueAtTime(110, t + 0.035);
          g.gain.setValueAtTime(0.5, t);
          g.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
          strike.connect(g);
          g.connect(out);
          strike.start(t);
          strike.stop(t + 0.045);
        }
      },
    };

    return {
      play: (type = "click", theme = "brass") => {
        try {
          const c = getContext();
          if (!c) return;
          const out = getMaster(c);
          const synth = synths[theme] || synths.brass;
          synth(c, out, type);
        } catch (e) {
          // Graceful fallback
        }
      },
      dispose: () => {
        if (ctx && ctx.state !== "closed") void ctx.close().catch(() => undefined);
        ctx = null;
        masterGain = null;
        compressor = null;
      },
    };
  })();

export function playPrototypeSound(type = "click", theme = "brass") {
  SoundEngine.play(type, theme);
}

export function disposePrototypeSound() {
  SoundEngine.dispose();
}
