var device = null;
(function() {
    'use strict';

    function hex4(n) {
        let s = n.toString(16)
        while (s.length < 4) {
            s = '0' + s;
        }
        return s;
    }

    function hexAddr8(n) {
        let s = n.toString(16)
        while (s.length < 8) {
            s = '0' + s;
        }
        return "0x" + s;
    }

    function niceSize(n) {
        const gigabyte = 1024 * 1024 * 1024;
        const megabyte = 1024 * 1024;
        const kilobyte = 1024;
        if (n >= gigabyte) {
            return n / gigabyte + "GiB";
        } else if (n >= megabyte) {
            return n / megabyte + "MiB";
        } else if (n >= kilobyte) {
            return n / kilobyte + "KiB";
        } else {
            return n + "B";
        }
    }

    function formatDFUSummary(device) {
        const vid = hex4(device.device_.vendorId);
        const pid = hex4(device.device_.productId);
        const name = device.device_.productName;

        let mode = "Unknown"
        if (device.settings.alternate.interfaceProtocol == 0x01) {
            mode = "Runtime";
        } else if (device.settings.alternate.interfaceProtocol == 0x02) {
            mode = "DFU";
        }

        const cfg = device.settings.configuration.configurationValue;
        const intf = device.settings["interface"].interfaceNumber;
        const alt = device.settings.alternate.alternateSetting;
        const serial = device.device_.serialNumber;
        let info = `${mode}: [${vid}:${pid}] cfg=${cfg}, intf=${intf}, alt=${alt}, name="${name}" serial="${serial}"`;
        return info;
    }

    function formatDFUInterfaceAlternate(settings) {
        let mode = "Unknown"
        if (settings.alternate.interfaceProtocol == 0x01) {
            mode = "Runtime";
        } else if (settings.alternate.interfaceProtocol == 0x02) {
            mode = "DFU";
        }

        const cfg = settings.configuration.configurationValue;
        const intf = settings["interface"].interfaceNumber;
        const alt = settings.alternate.alternateSetting;
        const name = (settings.name) ? settings.name : "UNKNOWN";

        return `${mode}: cfg=${cfg}, intf=${intf}, alt=${alt}, name="${name}"`;
    }

    async function fixInterfaceNames(device_, interfaces) {
        // Check if any interface names were not read correctly
        if (interfaces.some(intf => (intf.name == null))) {
            // Manually retrieve the interface name string descriptors
            let tempDevice = new dfu.Device(device_, interfaces[0]);
            await tempDevice.device_.open();
            await tempDevice.device_.selectConfiguration(1);
            let mapping = await tempDevice.readInterfaceNames();
            await tempDevice.close();

            for (let intf of interfaces) {
                if (intf.name === null) {
                    let configIndex = intf.configuration.configurationValue;
                    let intfNumber = intf["interface"].interfaceNumber;
                    let alt = intf.alternate.alternateSetting;
                    intf.name = mapping[configIndex][intfNumber][alt];
                }
            }
        }
    }

    function populateInterfaceList(form, device_, interfaces) {
        let old_choices = Array.from(form.getElementsByTagName("div"));
        for (let radio_div of old_choices) {
            form.removeChild(radio_div);
        }

        let button = form.getElementsByTagName("button")[0];

        for (let i=0; i < interfaces.length; i++) {
            let radio = document.createElement("input");
            radio.type = "radio";
            radio.name = "interfaceIndex";
            radio.value = i;
            radio.id = "interface" + i;
            radio.required = true;

            let label = document.createElement("label");
            label.textContent = formatDFUInterfaceAlternate(interfaces[i]);
            label.className = "radio"
            label.setAttribute("for", "interface" + i);

            let div = document.createElement("div");
            div.appendChild(radio);
            div.appendChild(label);
            form.insertBefore(div, button);
        }
    }

    function getDFUDescriptorProperties(device) {
        // Attempt to read the DFU functional descriptor
        // TODO: read the selected configuration's descriptor
        return device.readConfigurationDescriptor(0).then(
            data => {
                let configDesc = dfu.parseConfigurationDescriptor(data);
                let funcDesc = null;
                let configValue = device.settings.configuration.configurationValue;
                if (configDesc.bConfigurationValue == configValue) {
                    for (let desc of configDesc.descriptors) {
                        if (desc.bDescriptorType == 0x21 && desc.hasOwnProperty("bcdDFUVersion")) {
                            funcDesc = desc;
                            break;
                        }
                    }
                }

                if (funcDesc) {
                    return {
                        WillDetach:            ((funcDesc.bmAttributes & 0x08) != 0),
                        ManifestationTolerant: ((funcDesc.bmAttributes & 0x04) != 0),
                        CanUpload:             ((funcDesc.bmAttributes & 0x02) != 0),
                        CanDnload:             ((funcDesc.bmAttributes & 0x01) != 0),
                        TransferSize:          funcDesc.wTransferSize,
                        DetachTimeOut:         funcDesc.wDetachTimeOut,
                        DFUVersion:            funcDesc.bcdDFUVersion
                    };
                } else {
                    return {};
                }
            },
            error => {}
        );
    }

    // Current log div element to append to
    let logContext = null;

    function setLogContext(div) {
        logContext = div;
    };

    function clearLog(context) {
        if (typeof context === 'undefined') {
            context = logContext;
        }
        if (context) {
            context.innerHTML = "";
        }
    }

    function logDebug(msg) {
        console.log(msg);
    }

    function logInfo(msg) {
        if (logContext) {
            let info = document.createElement("p");
            info.className = "info";
            info.textContent = msg;
            logContext.appendChild(info);
        }
    }

    function logWarning(msg) {
        // After a successful firmware update, devices often reboot/disconnect.
        // Suppress scary but expected status polling messages in the UI log.
        const msgStr = String(msg);
        if (msgStr.startsWith("getStatus failed, retrying") ||
            msgStr.includes("Failed to get status after 3 retries: Device disconnected (expected after firmware update)")) {
            return;
        }
        if (logContext) {
            let warning = document.createElement("p");
            warning.className = "warning";
            warning.textContent = msg;
            logContext.appendChild(warning);
        }
    }

    function logError(msg) {
        // Suppress expected disconnect message after a successful update.
        const msgStr = String(msg);
        if (msgStr.includes("Failed to get status after 3 retries: Device disconnected (expected after firmware update)")) {
            return;
        }
        if (logContext) {
            let error = document.createElement("p");
            error.className = "error";
            error.textContent = msg;
            logContext.appendChild(error);
        }
    }

    function logProgress(done, total) {
        if (logContext) {
            let progressBar;
            if (logContext.lastChild.tagName.toLowerCase() == "progress") {
                progressBar = logContext.lastChild;
            }
            if (!progressBar) {
                progressBar = document.createElement("progress");
                logContext.appendChild(progressBar);
            }
            progressBar.value = done;
            if (typeof total !== 'undefined') {
                progressBar.max = total;
            }
        }
    }

    document.addEventListener('DOMContentLoaded', event => {
        let connectButton = document.querySelector("#connect");
        let detachButton = document.querySelector("#detach");
        let downloadButton = document.querySelector("#download");
        let uploadButton = document.querySelector("#upload");
        let statusDisplay = document.querySelector("#status");
        let infoDisplay = document.querySelector("#usbInfo");
        let dfuDisplay = document.querySelector("#dfuInfo");
        let vidField = document.querySelector("#vid");
        let interfaceDialog = document.querySelector("#interfaceDialog");
        let interfaceForm = document.querySelector("#interfaceForm");
        let interfaceSelectButton = document.querySelector("#selectInterface");

        let searchParams = new URLSearchParams(window.location.search);
        let fromLandingPage = false;
        let vid = 0;
        // Set the vendor ID from the landing page URL
        if (searchParams.has("vid")) {
            const vidString = searchParams.get("vid");
            try {
                if (vidString.toLowerCase().startsWith("0x")) {
                    vid = parseInt(vidString, 16);
                } else {
                    vid = parseInt(vidString, 10);
                }
                vidField.value = "0x" + hex4(vid).toUpperCase();
                fromLandingPage = true;
            } catch (error) {
                console.log("Bad VID " + vidString + ":" + error);
            }
        }

        // Grab the serial number from the landing page
        let serial = "";
        if (searchParams.has("serial")) {
            serial = searchParams.get("serial");
            // Workaround for Chromium issue 339054
            if (window.location.search.endsWith("/") && serial.endsWith("/")) {
                serial = serial.substring(0, serial.length-1);
            }
            fromLandingPage = true;
        }

        let configForm = document.querySelector("#configForm");

        let transferSizeField = document.querySelector("#transferSize");
        let transferSize = parseInt(transferSizeField.value);

        let dfuseStartAddressField = document.querySelector("#dfuseStartAddress");
        let dfuseUploadSizeField = document.querySelector("#dfuseUploadSize");

        let firmwareFileField = document.querySelector("#firmwareFile");
        let firmwareFile = null;
        let selectFirmwareButton = document.querySelector("#selectFirmware");
        let firmwareSelectDialog = document.querySelector("#firmwareSelectDialog");
        let firmwareList = document.querySelector("#firmwareList");
        let selectedFirmwareName = document.querySelector("#selectedFirmwareName");
        let cancelFirmwareSelectButton = document.querySelector("#cancelFirmwareSelect");

        let downloadLog = document.querySelector("#downloadLog");
        let uploadLog = document.querySelector("#uploadLog");

        let manifestationTolerant = true;

        //let device;
        // Allow selecting firmware before connecting.
        selectFirmwareButton.disabled = false;
        updateDnloadButtonState();

        function updateDnloadButtonState() {
            // Enable download when connected and device supports download + firmware selected.
            // (Avoid relying solely on interfaceProtocol; it can vary by interface/browsers.)
            const isConnected = !!(device && device.device_ && device.device_.opened);
            const canDnload = !!(device && device.properties && device.properties.CanDnload);
            downloadButton.disabled = !(isConnected && canDnload && firmwareFile);
        }

        function onDisconnect(reason) {
            if (reason) {
                statusDisplay.textContent = reason;
            }

            connectButton.textContent = "Connect";
            infoDisplay.textContent = "";
            dfuDisplay.textContent = "";
            detachButton.disabled = true;
            uploadButton.disabled = true;
            firmwareFileField.disabled = true;
            // Allow firmware selection even before connecting; keep selection across disconnects.
            selectFirmwareButton.disabled = false;
            updateDnloadButtonState();
        }

        function onUnexpectedDisconnect(event) {
            if (device !== null && device.device_ !== null) {
                if (device.device_ === event.device) {
                    device.disconnected = true;
                    onDisconnect("Device disconnected");
                    device = null;
                }
            }
        }

        async function connect(device) {
            try {
                await device.open();
            } catch (error) {
                onDisconnect(error);
                throw error;
            }

            // Attempt to parse the DFU functional descriptor
            let desc = {};
            try {
                desc = await getDFUDescriptorProperties(device);
            } catch (error) {
                onDisconnect(error);
                throw error;
            }

            let memorySummary = "";
            if (desc && Object.keys(desc).length > 0) {
                device.properties = desc;
                let info = `WillDetach=${desc.WillDetach}, ManifestationTolerant=${desc.ManifestationTolerant}, CanUpload=${desc.CanUpload}, CanDnload=${desc.CanDnload}, TransferSize=${desc.TransferSize}, DetachTimeOut=${desc.DetachTimeOut}, Version=${hex4(desc.DFUVersion)}`;
                dfuDisplay.textContent += "\n" + info;
                transferSizeField.value = desc.TransferSize;
                transferSize = desc.TransferSize;
                if (desc.CanDnload) {
                    manifestationTolerant = desc.ManifestationTolerant;
                }

                if (device.settings.alternate.interfaceProtocol == 0x02) {
                    if (!desc.CanUpload) {
                        uploadButton.disabled = true;
                        dfuseUploadSizeField.disabled = true;
                    }
                    if (!desc.CanDnload) {
                        dnloadButton.disabled = true;
                    }
                }

                if (desc.DFUVersion == 0x011a && device.settings.alternate.interfaceProtocol == 0x02) {
                    device = new dfuse.Device(device.device_, device.settings);
                    if (device.memoryInfo) {
                        let totalSize = 0;
                        for (let segment of device.memoryInfo.segments) {
                            totalSize += segment.end - segment.start;
                        }
                        memorySummary = `Selected memory region: ${device.memoryInfo.name} (${niceSize(totalSize)})`;
                        for (let segment of device.memoryInfo.segments) {
                            let properties = [];
                            if (segment.readable) {
                                properties.push("readable");
                            }
                            if (segment.erasable) {
                                properties.push("erasable");
                            }
                            if (segment.writable) {
                                properties.push("writable");
                            }
                            let propertySummary = properties.join(", ");
                            if (!propertySummary) {
                                propertySummary = "inaccessible";
                            }

                            memorySummary += `\n${hexAddr8(segment.start)}-${hexAddr8(segment.end-1)} (${propertySummary})`;
                        }
                    }
                }
            }

            // Bind logging methods
            device.logDebug = logDebug;
            device.logInfo = logInfo;
            device.logWarning = logWarning;
            device.logError = logError;
            device.logProgress = logProgress;

            // Clear logs
            clearLog(uploadLog);
            clearLog(downloadLog);

            // Display basic USB information
            statusDisplay.textContent = '';
            connectButton.textContent = 'Disconnect';
            infoDisplay.textContent = (
                "Name: " + device.device_.productName + "\n" +
                "MFG: " + device.device_.manufacturerName + "\n" +
                "Serial: " + device.device_.serialNumber + "\n"
            );

            // Display basic dfu-util style info
            dfuDisplay.textContent = formatDFUSummary(device) + "\n" + memorySummary;

            // Update buttons based on capabilities
            if (device.settings.alternate.interfaceProtocol == 0x01) {
                // Runtime
                detachButton.disabled = false;
                uploadButton.disabled = true;
                firmwareFileField.disabled = true;
                selectFirmwareButton.disabled = false;
            } else {
                // DFU
                detachButton.disabled = true;
                uploadButton.disabled = false;
                firmwareFileField.disabled = false;
                selectFirmwareButton.disabled = false;
            }
            updateDnloadButtonState();

            if (device.memoryInfo) {
                let dfuseFieldsDiv = document.querySelector("#dfuseFields")
                dfuseFieldsDiv.hidden = false;
                dfuseStartAddressField.disabled = false;
                dfuseUploadSizeField.disabled = false;
                let segment = device.getFirstWritableSegment();
                if (segment) {
                    device.startAddress = segment.start;
                    dfuseStartAddressField.value = "0x" + segment.start.toString(16);
                    const maxReadSize = device.getMaxReadSize(segment.start);
                    dfuseUploadSizeField.value = maxReadSize;
                    dfuseUploadSizeField.max = maxReadSize;
                }
            } else {
                let dfuseFieldsDiv = document.querySelector("#dfuseFields")
                dfuseFieldsDiv.hidden = true;
                dfuseStartAddressField.disabled = true;
                dfuseUploadSizeField.disabled = true;
            }

            return device;
        }

        function autoConnect(vid, serial) {
            dfu.findAllDfuInterfaces().then(
                async dfu_devices => {
                    let matching_devices = [];
                    for (let dfu_device of dfu_devices) {
                        if (serial) {
                            if (dfu_device.device_.serialNumber == serial) {
                                matching_devices.push(dfu_device);
                            }
                        } else if (dfu_device.device_.vendorId == vid) {
                            matching_devices.push(dfu_device);
                        }
                    }

                    if (matching_devices.length == 0) {
                        statusDisplay.textContent = 'No device found.';
                    } else {
                        // Automatically select interface containing Internal Flash
                        let selectedDevice = null;
                        if (matching_devices.length == 1) {
                            selectedDevice = matching_devices[0];
                        } else {
                            // If multiple interfaces exist, find one containing Internal Flash
                            for (let dfu_device of matching_devices) {
                                // May need to call fixInterfaceNames to get interface names,
                                // but first check settings.name
                                if (dfu_device.settings && dfu_device.settings.name && 
                                    dfu_device.settings.name.toLowerCase().includes("internal flash")) {
                                    selectedDevice = dfu_device;
                                    break;
                                }
                            }
                            // If Internal Flash not found, use first device
                            if (!selectedDevice) {
                                selectedDevice = matching_devices[0];
                            }
                        }
                        
                        if (selectedDevice) {
                            statusDisplay.textContent = 'Connecting...';
                            // Fix interface names if needed
                            if (selectedDevice.device_ && selectedDevice.device_.opened === false) {
                                let interfaces = dfu.findDeviceDfuInterfaces(selectedDevice.device_);
                                await fixInterfaceNames(selectedDevice.device_, interfaces);
                                // Recreate device with fixed interface information
                                for (let intf of interfaces) {
                                    if (intf.configuration.configurationValue == selectedDevice.settings.configuration.configurationValue &&
                                        intf["interface"].interfaceNumber == selectedDevice.settings["interface"].interfaceNumber &&
                                        intf.alternate.alternateSetting == selectedDevice.settings.alternate.alternateSetting) {
                                        selectedDevice = new dfu.Device(selectedDevice.device_, intf);
                                        break;
                                    }
                                }
                            }
                            device = selectedDevice;
                            console.log(device);
                            device = await connect(device);
                        }
                        vidField.value = "0x" + hex4(matching_devices[0].device_.vendorId).toUpperCase();
                        vid = matching_devices[0].device_.vendorId;
                    }
                }
            );
        }

        vidField.addEventListener("change", function() {
            vid = parseInt(vidField.value, 16);
        });

        transferSizeField.addEventListener("change", function() {
            transferSize = parseInt(transferSizeField.value);
        });

        dfuseStartAddressField.addEventListener("change", function(event) {
            const field = event.target;
            let address = parseInt(field.value, 16);
            if (isNaN(address)) {
                field.setCustomValidity("Invalid hexadecimal start address");
            } else if (device && device.memoryInfo) {
                if (device.getSegment(address) !== null) {
                    device.startAddress = address;
                    field.setCustomValidity("");
                    dfuseUploadSizeField.max = device.getMaxReadSize(address);
                } else {
                    field.setCustomValidity("Address outside of memory map");
                }
            } else {
                field.setCustomValidity("");
            }
        });

        connectButton.addEventListener('click', function() {
            if (device) {
                device.close().then(onDisconnect);
                device = null;
            } else {
                let filters = [];
                if (serial) {
                    filters.push({ 'serialNumber': serial });
                } else if (vid) {
                    filters.push({ 'vendorId': vid });
                }
                navigator.usb.requestDevice({ 'filters': filters }).then(
                    async selectedDevice => {
                        let interfaces = dfu.findDeviceDfuInterfaces(selectedDevice);
                        if (interfaces.length == 0) {
                            console.log(selectedDevice);
                            statusDisplay.textContent = "The selected device does not have any USB DFU interfaces.";
                        } else if (interfaces.length == 1) {
                            await fixInterfaceNames(selectedDevice, interfaces);
                            device = await connect(new dfu.Device(selectedDevice, interfaces[0]));
                        } else {
                            await fixInterfaceNames(selectedDevice, interfaces);
                            // Automatically select Internal Flash
                            let internalFlashIndex = -1;
                            for (let i = 0; i < interfaces.length; i++) {
                                if (interfaces[i].name && interfaces[i].name.toLowerCase().includes("internal flash")) {
                                    internalFlashIndex = i;
                                    break;
                                }
                            }
                            if (internalFlashIndex >= 0) {
                                // Auto-connect if Internal Flash found
                                device = await connect(new dfu.Device(selectedDevice, interfaces[internalFlashIndex]));
                            } else {
                                // Use first interface if Internal Flash not found
                                device = await connect(new dfu.Device(selectedDevice, interfaces[0]));
                            }
                        }
                    }
                ).catch(error => {
                    statusDisplay.textContent = error;
                });
            }
        });

        detachButton.addEventListener('click', function() {
            if (device) {
                device.detach().then(
                    async len => {
                        let detached = false;
                        try {
                            await device.close();
                            await device.waitDisconnected(5000);
                            detached = true;
                        } catch (err) {
                            console.log("Detach failed: " + err);
                        }

                        onDisconnect();
                        device = null;
                        if (detached) {
                            // Wait a few seconds and try reconnecting
                            setTimeout(autoConnect, 5000);
                        }
                    },
                    async error => {
                        await device.close();
                        onDisconnect(error);
                        device = null;
                    }
                );
            }
        });

        uploadButton.addEventListener('click', async function(event) {
            event.preventDefault();
            event.stopPropagation();
            if (!configForm.checkValidity()) {
                configForm.reportValidity();
                return false;
            }

            if (!device || !device.device_.opened) {
                onDisconnect();
                device = null;
            } else {
                setLogContext(uploadLog);
                clearLog(uploadLog);
                try {
                    let status = await device.getStatus();
                    if (status.state == dfu.dfuERROR) {
                        await device.clearStatus();
                    }
                } catch (error) {
                    device.logWarning("Failed to clear status");
                }

                let maxSize = Infinity;
                if (!dfuseUploadSizeField.disabled) {
                    maxSize = parseInt(dfuseUploadSizeField.value);
                }

                try {
                    const blob = await device.do_upload(transferSize, maxSize);
                    saveAs(blob, "firmware.bin");
                } catch (error) {
                    logError(error);
                }

                setLogContext(null);
            }

            return false;
        });

        firmwareFileField.addEventListener("change", function() {
            firmwareFile = null;
            if (firmwareFileField.files.length > 0) {
                let file = firmwareFileField.files[0];
                let reader = new FileReader();
                reader.onload = function() {
                    firmwareFile = reader.result;
                    updateDnloadButtonState();
                };
                reader.readAsArrayBuffer(file);
            }
        });

        function getFetchHint() {
            if (location.protocol === 'file:') {
                return '';
            }
            return '';
        }

        // Get firmware list from firmware.json (array of objects)
        async function getFirmwareList() {
            try {
                const response = await fetch('firmware.json', { cache: 'no-cache' });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const list = await response.json();
                // Expecting: [{ id, name, filepath, description?, bgColor?, active? }, ...]
                if (!Array.isArray(list)) throw new Error('Invalid firmware.json (expected array)');
                // Normalize minimal shape we need
                const items = list
                    .filter(item => typeof item.filepath === 'string')
                    .map(item => ({
                        id: item.id ?? null,
                        name: item.name ?? (item.filepath.split('/').pop() || 'firmware.bin'),
                        url: item.filepath,
                        description: item.description ?? '',
                        bgColor: item.bgColor ?? '',
                        active: !!item.active,
                    }));
                return { items, error: null };
            } catch (error) {
                console.error('Failed to get firmware list:', error);
                return { items: [], error };
            }
        }

        // Load firmware file from given URL (https:// or relative)
        async function loadFirmwareFileFromUrl(name, url) {
            try {
                const response = await fetch(url, { cache: 'no-cache' });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const arrayBuffer = await response.arrayBuffer();
                firmwareFile = arrayBuffer;
                selectedFirmwareName.textContent = `Selected: ${name}`;
                firmwareSelectDialog.close();
                updateDnloadButtonState();
                return true;
            } catch (error) {
                console.error('Failed to load firmware file:', error);
                const hint = getFetchHint();
                alert('Failed to load firmware file: ' + error + (hint ? `\n\n${hint}` : ''));
                return false;
            }
        }

        // Select Firmware button event listener
        selectFirmwareButton.addEventListener('click', async function(event) {
            event.preventDefault();
            event.stopPropagation();
            
            firmwareList.innerHTML = '<p>Loading...</p>';
            firmwareSelectDialog.showModal();
            
            const { items, error } = await getFirmwareList();
            
            if (items.length === 0) {
                const hint = getFetchHint();
                const errText = error ? String(error) : 'No firmware entries found in firmware.json.';
                firmwareList.innerHTML = `<p style="color:red;">${errText}</p>` + (hint ? `<p>${hint}</p>` : '');
                return;
            }
            
            firmwareList.innerHTML = '';
            const ul = document.createElement('ul');
            items.forEach(item => {
                const li = document.createElement('li');
                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = item.name;
                button.style.cssText = 'margin: 5px; padding: 5px 10px; cursor: pointer;';
                if (item.bgColor) {
                    button.style.backgroundColor = item.bgColor;
                    // sakura.css sets button text to white; ensure contrast on light bgColor
                    button.style.color = '#4a4a4a';
                    button.style.borderColor = '#4a4a4a';
                }
                if (item.description) {
                    button.title = item.description;
                }
                button.addEventListener('click', async function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    await loadFirmwareFileFromUrl(item.name, item.url);
                });
                li.appendChild(button);
                ul.appendChild(li);
            });
            firmwareList.appendChild(ul);
        });

        // キャンセルボタンのイベントリスナー
        cancelFirmwareSelectButton.addEventListener('click', function() {
            firmwareSelectDialog.close();
        });

        downloadButton.addEventListener('click', async function(event) {
            event.preventDefault();
            event.stopPropagation();
            if (!configForm.checkValidity()) {
                configForm.reportValidity();
                return false;
            }

            if (device && firmwareFile != null) {
                setLogContext(downloadLog);
                clearLog(downloadLog);
                
                // Check and reset device status
                let deviceReady = false;
                let retryCount = 0;
                const maxRetries = 3;
                
                while (!deviceReady && retryCount < maxRetries) {
                    try {
                        let status = await device.getStatus();
                        if (status.state == dfu.dfuERROR) {
                            logInfo("Device is in error state. Resetting...");
                            await device.clearStatus();
                        }
                        deviceReady = true;
                    } catch (error) {
                        retryCount++;
                        if (retryCount >= maxRetries) {
                            // If getStatus fails, reset device and retry
                            logWarning("Failed to get device status. Attempting to reset...");
                            try {
                                // abortToIdle also uses getState, so try abort directly
                                await device.abort();
                                logInfo("Device reset successful");
                                deviceReady = true;
                            } catch (resetError) {
                                logWarning("Device reset failed, but continuing: " + resetError);
                                deviceReady = true; // Try to continue even on error
                            }
                        } else {
                            logWarning("getStatus failed, retrying (" + retryCount + "/" + maxRetries + ")...");
                            await new Promise(resolve => setTimeout(resolve, 200));
                        }
                    }
                }
                
                await device.do_download(transferSize, firmwareFile, manifestationTolerant).then(
                    () => {
                        logInfo("Done!");
                        setLogContext(null);
                        if (!manifestationTolerant && device && device.waitDisconnected) {
                            device.waitDisconnected(5000).then(
                                dev => {
                                    onDisconnect();
                                    device = null;
                                },
                                error => {
                                    // It didn't reset and disconnect for some reason...
                                    console.log("Device unexpectedly tolerated manifestation.");
                                }
                            );
                        }
                    },
                    error => {
                        logError(error);
                        setLogContext(null);
                    }
                )
            }

            //return false;
        });

        // Check if WebUSB is available
        if (typeof navigator.usb !== 'undefined') {
            navigator.usb.addEventListener("disconnect", onUnexpectedDisconnect);
            // Try connecting automatically
            if (fromLandingPage) {
                autoConnect(vid, serial);
            }
        } else {
            statusDisplay.textContent = 'WebUSB not available.'
            connectButton.disabled = true;
        }
    });
})();
