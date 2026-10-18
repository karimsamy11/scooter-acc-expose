# Scooter ACC Drive Assist: public engineering brief

Version 0.1, 18 Oct 2026. Status: DRAFT, waiting for owner approval.
Source: only facts already published in the public exposé (https://karimsamy11.github.io/scooter-acc-expose/). No private code or documents.

## 1. Objective
Adaptive distance assistance for standing electric kick scooters. The system watches the road ahead, limits motor power to keep a safe gap, caps commanded speed at 20 km/h and warns the rider before a collision. The rider always brakes. The system never brakes on its own.

Why: Germany recorded 16,496 e-scooter accidents with personal injury in 2025 (+38.1 % on 2024) and 38 deaths (Destatis, press release N049, July 2026). Excessive speed and errors in dense traffic are among the leading causes.

## 2. Fixed functional requirements (any proposal must meet these)
- FR-1 Vehicle: standing electric kick scooter (German eKFV class).
- FR-2 Forward obstacle detection: detect and track the road user ahead (vehicle, cyclist, pedestrian).
- FR-3 Adaptive motor power limitation: inside the safe gap the motor gets no extra power. Reference gap rule: 3 m + 2 s of travel at the current speed.
- FR-4 Maximum commanded propulsion speed 20 km/h. At or above it, no extra motor power.
- FR-5 Early collision warning: visible and audible warning when time to collision (TTC) drops below a threshold (reference value 3 s, provisional). The warning must work in every state, including after the rider has braked.
- FR-6 No autonomous braking. The system may only reduce or withhold propulsion.
- FR-7 The rider remains responsible for braking. The rider's brake always overrides the system.
- FR-8 Fail safe: stale or invalid sensor data, a missed heartbeat, low detection confidence or a rider brake must remove motor authority (reference: within the same 20 ms control cycle).

Everything else is open: sensors, processors, algorithms, software architecture, partitioning.

## 3. Reference architecture (one possible solution, not the required one)
- Sensors: forward camera, FMCW radar (module not selected yet), GNSS, IMU, wheel encoder.
- Perception computer: Raspberry Pi 5 with AI HAT+ (Hailo accelerator). Object detection, radar–camera fusion, logging. Not trusted with the motor.
- Safety controller: STM32G474 microcontroller. Checks every message, latches faults, enforces limits, gives the brake priority. Planned for the lab stage.
- Motor controller: disabled in this version. Only through a documented manufacturer interface, never directly from the Pi.
- Control loop: 50 Hz (20 ms) in simulation.
- Parts cost: not published in this brief. Cost comparisons should state their own assumptions.

Known questions about this design, open for challenge: Is a two-processor split necessary? Is camera + radar fusion necessary, or would radar alone (or a cheaper sensor) meet FR-2? Can the safety function be simpler and independently verifiable? What is the cheapest design that still meets FR-1 to FR-8?

## 4. Evidence so far (simulation only)
All results come from the control and safety logic (controller v0.2) running in simulation with an illustrative vehicle model. They are not real-world stopping tests.
- 25 of 25 automated safety tests pass in continuous integration (Python 3.11).
- Hard-braking vehicle ahead (scenario S2): warning 3.4 s before contact; the previous version (v0.1.0) gave none.
- Set speed 30 km/h on an open road: v0.1.0 reached 21.2 km/h; v0.2 stays below 20 km/h.
- Sensor fault, then rider brakes and re-engages: v0.1.0 accelerated again; v0.2 stays in a latched safe fault mode.
- Stale sensor data: motor power cut (at 10.14 s in the scenario).
- Small-town ride demo: following a cyclist, switching to a car, a warning when the car brakes hard at a red light, and an ACC cancellation where camera confidence drops in an underpass. Rider and traffic are scripted.

## 5. Known limitations and open findings
- No hardware exists yet. No sensor, timing or stopping performance has been measured.
- The 3 s warning threshold is provisional and not validated with riders.
- F-008: with no road user ahead at all, v0.2 treats the missing target as untrusted perception and cancels ACC instead of cruising at the set speed. Not fixed yet.
- The independent safety chip is planned for the hardware stage and does not exist yet.
- The vehicle model is illustrative; top speed in the town demo stays near 14 km/h because of the model.

## 6. Safety constraints for every proposal
- Simulation and bench first. No public-road tests, no real motor commands without a documented safety review, hardware interlock and fault-injection tests.
- No automatic braking. No modification of the scooter's existing brakes or safety controls.
- No claims of road legality, ISO 26262/ASIL compliance, certification or validated stopping performance.
- The perception computer must not command the motor directly without independent validation.

## 7. Roadmap stages
1 Concept (now): simulation, tests, requirements. 2 Lab: safety chip, emulated motor, fault injection; gate: timing measured. 3 Field: closed test track only; gate: safety review and site approval. 4 Pilot: custom board, small fleet with a partner. 5 Industrialise. 6 Series.

## 8. What a good proposal shows
A clear problem statement, the proposed architecture, what changes against the reference design, expected benefits (cost, power, complexity, safety), risks, how it addresses FR-1 to FR-8, and measurable validation tests (for example: detection range and rate for each target class, end-to-end latency from detection to propulsion cut, fault-reaction time, false-warning rate per km).
