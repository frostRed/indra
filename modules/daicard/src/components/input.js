import {
  Button,
  InputAdornment,
  Modal,
  TextField,
  Tooltip,
} from "@material-ui/core";
import { arrayify, isHexString } from "ethers/utils";
import React, { useEffect, useState } from "react";
import QRIcon from "mdi-material-ui/QrcodeScan";

import { QRScan } from "./qrCode";

const useDebounce = (value, delay) => {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay)
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debouncedValue;
}

export const useAddress = (initialAddress, ethProvider, network) => {
  const [addressDisplay, setAddressDisplay] = useState(initialAddress);
  const [addressValue, setAddressValue] = useState(null);
  const [addressError, setAddressError] = useState(null);
  const debouncedAddress = useDebounce(addressDisplay, 1000);
  useEffect(() => {
    (async () => {
      if (debouncedAddress === null) return;
      let value = debouncedAddress;
      let error;
      if (debouncedAddress.startsWith("ethereum:")) {
        value = debouncedAddress.split(":")[1];
      }
      if (network.ensAddress && value.endsWith('.eth')) {
        value = await ethProvider.resolveName(value);
      }
      if (value === "") {
        error = "Please provide an address or ens name";
      } else if (!isHexString(value)) {
        error = `Invalid hex string`;
      } else if (arrayify(value).length !== 20) {
        error = `Invalid length: ${value.length} (expected 42)`;
      }
      setAddressValue(error ? undefined : value);
      setAddressError(error);
    })()
  }, [debouncedAddress, ethProvider, network.ensAddress]);
  return [
    { display: addressDisplay, value: addressValue, error: addressError },
    setAddressDisplay,
  ];
}

export const useXpub = (initialXpub) => {
  const [xpubDisplay, setXpubDisplay] = useState(initialXpub);
  const [xpubValue, setXpubValue] = useState(null);
  const [xpubError, setXpubError] = useState(null);
  const debouncedXpub = useDebounce(xpubDisplay, 1000);
  useEffect(() => {
    (async () => {
      if (debouncedXpub === null) return;
      const xpubLen = 111;
      let value = null;
      let error = null;
      value = debouncedXpub;
      if (!value || !value.startsWith("xpub")) {
        error = `Invalid xpub: should start with "xpub"`;
      }
      if (!error && value.length !== xpubLen) {
        error = `Invalid length: ${value.length} (expected ${xpubLen})`;
      }
      setXpubValue(error ? undefined : value);
      setXpubError(error);
    })()
  }, [debouncedXpub]);
  return [
    { display: xpubDisplay, value: xpubValue, error: xpubError },
    setXpubDisplay,
  ];
}

export const XpubInput = ({ xpub, setXpub }) => {
  const [scan, setScan] = useState(false);
  return (
    <div>
      <TextField
        fullWidth
        id="outlined"
        label="Recipient Public Identifier"
        type="string"
        value={xpub.display || ""}
        onChange={evt => setXpub(evt.target.value)}
        margin="normal"
        variant="outlined"
        helperText={xpub.error ? xpub.error : "Ignored for linked payments"}
        error={xpub.error !== null}
        InputProps={{
          endAdornment: (
            <InputAdornment position="end">
              <Tooltip disableFocusListener disableTouchListener title="Scan with QR code">
                <Button
                  disableTouchRipple
                  variant="contained"
                  color="primary"
                  style={{ color: "#FFF" }}
                  onClick={() => setScan(true)}
                >
                  <QRIcon />
                </Button>
              </Tooltip>
            </InputAdornment>
          ),
        }}
      />
      <Modal
        id="qrscan"
        open={scan}
        onClose={() => setScan(false)}
        style={{
          justifyContent: "center",
          alignItems: "center",
          textAlign: "center",
          position: "absolute",
          top: "10%",
          width: "375px",
          marginLeft: "auto",
          marginRight: "auto",
          left: "0",
          right: "0",
        }}
      >
        <QRScan handleResult={(res) => {
          // Extract the xpub from a request link if necessary
          const i = res.indexOf('=xpub')
          if (i !== -1) {
            setXpub(res.substring(i + 1, i + 112));
          } else {
            setXpub(res);
          }
          setScan(false);
        }} />
      </Modal>
    </div>
  );
}

export const AddressInput = ({ address, setAddress }) => {
  const [scan, setScan] = useState(false);
  return (
    <div>
      <TextField
        style={{ width: "100%" }}
        id="outlined-with-placeholder"
        label="Address"
        placeholder="0x0..."
        value={address.display || ""}
        onChange={evt => setAddress(evt.target.value)}
        margin="normal"
        variant="outlined"
        required
        helperText={address.error}
        error={!!address.error}
        InputProps={{
          endAdornment: (
            <InputAdornment position="end">
              <Tooltip disableFocusListener disableTouchListener title="Scan with QR code">
                <Button
                  disableTouchRipple
                  variant="contained"
                  color="primary"
                  style={{ color: "primary" }}
                  onClick={() => setScan(true)}
                >
                  <QRIcon />
                </Button>
              </Tooltip>
            </InputAdornment>
          ),
        }}
      />
      <Modal
        id="qrscan"
        open={scan}
        onClose={() => setScan(false)}
        style={{
          justifyContent: "center",
          alignItems: "center",
          textAlign: "center",
          position: "absolute",
          top: "10%",
          width: "375px",
          marginLeft: "auto",
          marginRight: "auto",
          left: "0",
          right: "0",
        }}
      >
        <QRScan handleResult={(res) => {
          setAddress(res);
          setScan(false);
        }} />
      </Modal>
    </div>
  );
}

