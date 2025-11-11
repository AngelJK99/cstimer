"use strict";

/**
 * @function BtDeviceGroupFactory
 * @description
 * This factory function creates an object responsible for managing connections
 * to various Bluetooth Low Energy (BLE) devices, such as smart cubes and timers.
 * It abstracts device-specific communication details, allowing for a unified
 * interface to scan, connect, and interact with different hardware models.
 *
 * It maintains a registry of device drivers (`cubeModels`) and handles the
 * Web Bluetooth API interactions for device discovery and connection.
 *
 * @returns {object} An object with methods to manage Bluetooth device connections.
 */
function BtDeviceGroupFactory() {

	/**
	 * @private
	 * @type {object.<string, object>} Stores registered device models (drivers).
	 * Keys are device name prefixes (e.g., 'GAN', 'QY-Timer'), values are the cubeModel objects.
	 */
	var cubeModels = {};

	/**
	 * @function regCubeModel
	 * @description
	 * Registers a new Bluetooth device model (driver) with the factory.
	 * Device models are typically defined in separate files (e.g., `gancube.js`, `qiyitimer.js`).
	 *
	 * @param {object} cubeModel - The device model object to register.
	 *   Must have a `prefix` property (string or array of strings) for identification.
	 *   Should also contain `init`, `clear`, `opservs`, `cics`, etc.
	 */
	function regCubeModel(cubeModel) {
		if ($.isArray(cubeModel.prefix)) {
			cubeModel.prefix.map((prefix) => {
				cubeModels[prefix] = cubeModel;
			});
		} else {
			cubeModels[cubeModel.prefix] = cubeModel;
		}
	}

	/**
	 * @private
	 * @type {object|undefined} The currently active device driver (cubeModel) for the connected device.
	 */
	var cube = undefined;
	/**
	 * @private
	 * @type {BluetoothDevice|null} The currently connected BluetoothDevice object.
	 */
	var _device = null;

	/**
	 * @function toUuid128
	 * @description
	 * Converts a 16-bit UUID string to its full 128-bit Bluetooth UUID format.
	 * If the input is already a 128-bit UUID, it's returned as is (uppercased).
	 *
	 * @param {string} uuid - The UUID string (e.g., "fff0" or "0000fff0-...")
	 * @returns {string} The 128-bit uppercase UUID string.
	 */
	function toUuid128(uuid) {
		if (/^[0-9A-Fa-f]{4}$/.exec(uuid)) {
			uuid = "0000" + uuid + "-0000-1000-8000-00805F9B34FB";
		}
		return uuid.toUpperCase();
	}

	/**
	 * @function findUUID
	 * @description
	 * Searches an array of Bluetooth GATT services or characteristics for one matching a given UUID.
	 *
	 * @param {Array<BluetoothService|BluetoothCharacteristic>} elems - Array of services or characteristics.
	 * @param {string} uuid - The UUID to search for (can be 16-bit or 128-bit).
	 * @returns {BluetoothService|BluetoothCharacteristic|null} The matching element, or null if not found.
	 */
	function findUUID(elems, uuid) {
		uuid = toUuid128(uuid);
		for (var i = 0; i < elems.length; i++) {
			var elem = elems[i]
			if (toUuid128(elem.uuid) == uuid) {
				return elem;
			}
		}
		return null;
	}

	/**
	 * @function waitForAdvs
	 * @description
	 * Waits for Bluetooth advertisement packets from the currently selected device.
	 * This is used to capture manufacturer-specific data (like MAC addresses)
	 * that might not be available through GATT services directly.
	 *
	 * @returns {Promise<DataView>} A promise that resolves with the manufacturer data
	 *   from the first received advertisement, or rejects after a timeout.
	 */
	function waitForAdvs() {
		if (!_device || !_device.watchAdvertisements) {
			return Promise.reject(-1);
		}
		var abortController = new AbortController();
		return new Promise(function(resolve, reject) {
			var onAdvEvent = function(event) {
				giikerutil.log('[bluetooth] receive adv event', event);
				_device && _device.removeEventListener('advertisementreceived', onAdvEvent);
				abortController.abort();
				resolve(event.manufacturerData);
			};
			_device.addEventListener('advertisementreceived', onAdvEvent);
			_device.watchAdvertisements({ signal: abortController.signal });
			setTimeout(function() { // reject if no mac found
				_device && _device.removeEventListener('advertisementreceived', onAdvEvent);
				abortController.abort();
				reject(-2);
			}, 10000);
		});
	}

	/**
	 * @function onHardwareEvent
	 * @description
	 * A generic handler for hardware-related events, primarily disconnection.
	 * It stops the current connection and then invokes a registered event callback.
	 *
	 * @param {string} info - Type of event (e.g., 'disconnect').
	 * @param {Event} event - The original event object.
	 * @returns {Promise<void>} A promise that resolves after stopping and invoking the callback.
	 */
	function onHardwareEvent(info, event) {
		var res = Promise.resolve();
		if (info == 'disconnect') {
			res = Promise.resolve(stop(true));
		}
		return res.then(function () {
			// Invoke the external event callback if registered
			return typeof evtCallback == 'function' && evtCallback(info, event);
		});
	}

	/**
	 * @private
	 * @type {function(Event): Promise<void>} Bound version of `onHardwareEvent` for 'disconnect'.
	 */
	var onDisconnect = onHardwareEvent.bind(null, 'disconnect');

	/**
	 * @function init
	 * @description
	 * Initiates a Bluetooth device connection process.
	 *
	 * 1. Checks Web Bluetooth API availability.
	 * 2. If `reconnect` is true and a device is already selected, attempts to reconnect.
	 * 3. Builds filters for `requestDevice` based on registered `cubeModels`.
	 *    - `filters`: Uses `namePrefix` from all registered models.
	 *    - `optionalServices`: Collects all `opservs` from registered models.
	 *    - `optionalManufacturerData`: Collects all `cics` (Company Identifier Codes).
	 * 4. Prompts the user to select a Bluetooth device using `navigator.bluetooth.requestDevice()`.
	 * 5. Once a device is selected, it stores the device and attaches a `gattserverdisconnected` listener.
	 * 6. Identifies the appropriate device driver (`cubeModel`) based on the device's name prefix.
	 * 7. Calls the `init` method of the identified device driver to establish GATT services and characteristics.
	 *
	 * @param {boolean} reconnect - If true, attempts to reconnect to a previously selected device.
	 * @returns {Promise<void>} A promise that resolves when the device is successfully initialized, or rejects on error.
	 */
	function init(reconnect) {
		return giikerutil.chkAvail().then(function() {
			if (_device && reconnect) {
				giikerutil.log('[bluetooth]', 'reconnecting...', _device);
				return waitUntilDeviceAvailable(_device);
			}
			var filters = Object.keys(cubeModels).map((prefix) => ({ namePrefix: prefix }));
			var opservs = [...new Set(Array.prototype.concat.apply([], Object.values(cubeModels).map((cubeModel) => cubeModel.opservs || [])))];
			var cics = [...new Set(Array.prototype.concat.apply([], Object.values(cubeModels).map((cubeModel) => cubeModel.cics || [])))];
			giikerutil.log('[bluetooth]', 'scanning...', Object.keys(cubeModels));
			return window.navigator.bluetooth.requestDevice({
				filters: filters,
				optionalServices: opservs,
				optionalManufacturerData: cics
			});
		}).then(function(device) {
			giikerutil.log('[bluetooth]', 'BLE device is selected, name=' + device.name, device);
			_device = device;
			device.addEventListener('gattserverdisconnected', onDisconnect);
			cube = null;
			for (var prefix in cubeModels) {
				if (device.name.startsWith(prefix)) {
					cube = cubeModels[prefix];
					break;
				}
			}
			if (!cube) {
				return Promise.reject('Cannot detect device type');
			}
			return cube.init(device);
		});
	}

	/**
	 * @function waitUntilDeviceAvailable
	 * @description
	 * Waits for the selected Bluetooth device to start sending advertisement packets.
	 * This is particularly useful for devices that might not immediately advertise
	 * after being selected, or to ensure the device is truly active.
	 *
	 * @param {BluetoothDevice} device - The BluetoothDevice object to monitor.
	 * @returns {Promise<BluetoothDevice>} A promise that resolves with the device
	 *   once an advertisement is received, or rejects if the API is not supported.
	 */
	// Wait until target device start sending bluetooth advertisiment packets
	function waitUntilDeviceAvailable(device) {
		var abortController = new AbortController();
		return new Promise(function (resolve, reject) {
			if (!device.watchAdvertisements) {
				reject("Bluetooth Advertisements API is not supported by this browser");
			} else {
				var onAdvEvent = function (event) {
					DEBUG && console.log('[bluetooth] received advertisement packet from device', event);
					delete device.stopWaiting;
					device.removeEventListener('advertisementreceived', onAdvEvent);
					abortController.abort();
					resolve(device);
				};
				device.stopWaiting = function () {
					DEBUG && console.log('[bluetooth] cancel waiting for device advertisements');
					delete device.stopWaiting;
					device.removeEventListener('advertisementreceived', onAdvEvent);
					abortController.abort();
				}
				device.addEventListener('advertisementreceived', onAdvEvent);
				device.watchAdvertisements({ signal: abortController.signal });
				DEBUG && console.log('[bluetooth] start waiting for device advertisement packet');
			}
		});
	}

	/**
	 * @function stop
	 * @description
	 * Disconnects from the currently connected Bluetooth device.
	 *
	 * 1. Calls the `clear` method of the active device driver for device-specific cleanup.
	 * 2. Removes the `gattserverdisconnected` event listener.
	 * 3. Disconnects the GATT server.
	 * 4. Resets the internal `_device` state.
	 *
	 * @param {boolean} isHardwareEvent - True if the disconnection was triggered by a hardware event (e.g., actual device power-off).
	 * @returns {Promise<void>} A promise that resolves when the disconnection is complete.
	 */
	function stop(isHardwareEvent) {
		if (!_device) {
			return Promise.resolve();
		}
		// Call the device-specific clear function, then disconnect GATT and clean up.
		return Promise.resolve(cube && cube.clear(isHardwareEvent)).then(function () {
			_device.removeEventListener('gattserverdisconnected', onDisconnect);
			_device.gatt.disconnect();
			_device = null;
		});
	}

	/**
	 * @private
	 * @type {function(...any): void} A callback function to send data from the device driver
	 *   back to the main application logic. Initialized as a no-op.
	 */
	var callback = $.noop;
	/**
	 * @private
	 * @type {function(string, Event): void} A callback function to send event notifications
	 *   (like disconnection) from the device driver back to the main application logic. Initialized as a no-op.
	 */
	var evtCallback = $.noop;

	return {
		init: init,
		stop: stop,
		/**
		 * @public
		 * @returns {boolean} True if a device is currently connected or if DEBUGBL is enabled.
		 */
		isConnected: function() {
			return _device != null || DEBUGBL;
		},
		/**
		 * @public
		 * Sets the main data callback function.
		 * @param {function(...any): void} func - The function to call with device data.
		 */
		setCallback: function(func) {
			callback = func;
		},
		/**
		 * @public
		 * Sets the event callback function.
		 * @param {function(string, Event): void} func - The function to call with device events.
		 */
		setEventCallback: function(func) {
			evtCallback = func;
		},
		getCube: function() {
			return cube || (DEBUGBL && {
				getBatteryLevel: function() { return Promise.resolve(80); }
			});
		},
		regCubeModel: regCubeModel,
		findUUID: findUUID,
		waitForAdvs: waitForAdvs,
		onDisconnect: onDisconnect,
		/**
		 * @public
		 * Invokes the registered `callback` function with provided arguments.
		 * This is typically used by device drivers to send data back.
		 * @param {...any} args - Arguments to pass to the callback.
		 * @returns {any} The result of the callback function.
		 */
		callback: function() {
			return callback.apply(null, arguments);
		}
	};
}

// Instantiate the factory for smart cubes.
var GiikerCube = execMain(BtDeviceGroupFactory);
// Instantiate the factory for Bluetooth timers.
var BluetoothTimer = execMain(BtDeviceGroupFactory);

BluetoothTimer.CONST = (function() {
	var State = {};
	State.DISCONNECT = 0;  // Fired when timer is disconnected from bluetooth
	State.GET_SET = 1;     // Grace delay is expired and timer is ready to start
	State.HANDS_OFF = 2;   // Hands removed from the timer before grace delay expired
	State.RUNNING = 3;     // Timer is running
	State.STOPPED = 4;     // Timer is stopped, this event includes recorded time
	State.IDLE = 5;        // Timer is reset and idle
	State.HANDS_ON = 6;    // Hands are placed on the timer
	State.FINISHED = 7;    // Timer moves to this state immediately after STOPPED
	State.INSPECTION = 8;
	State.GAN_RESET = 9;
	return State;
})();
