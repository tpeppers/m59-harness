"""Optional authenticated Kasa adapter. JSON stdin/stdout; never logs credentials."""
import asyncio
import ctypes
import json
import logging
import os
import sys


def decrypt_password(encrypted):
    class Blob(ctypes.Structure):
        _fields_ = [('size', ctypes.c_ulong), ('data', ctypes.POINTER(ctypes.c_ubyte))]
    raw = bytes.fromhex(encrypted)
    buf = (ctypes.c_ubyte * len(raw)).from_buffer_copy(raw)
    source, target = Blob(len(raw), buf), Blob()
    crypt = ctypes.windll.crypt32
    if not crypt.CryptUnprotectData(ctypes.byref(source), None, None, None, None, 0, ctypes.byref(target)):
        raise ValueError('credentials unavailable')
    try:
        return ctypes.string_at(target.data, target.size).decode('utf-16-le')
    finally:
        ctypes.windll.kernel32.LocalFree(target.data)


def mac(value):
    return str(value).replace(':', '').replace('-', '').lower()


async def run(args):
    try:
        from kasa import Discover, Module
    except ImportError:
        return {'error': 'Install python-kasa with tools/m59-kasa-setup.ps1'}
    username, password = os.environ.get('KASA_USERNAME'), os.environ.get('KASA_PASSWORD')
    if not (username and password):
        try:
            with open(args['credentials'], encoding='utf-8-sig') as f:
                credentials = json.load(f)
            username = credentials['username']
            password = decrypt_password(credentials['password_dpapi'])
        except Exception:
            return {'error': 'TP-Link login unavailable: run tools/m59-kasa-setup.ps1 as the watcher user'}
    spec = args['spec']
    device = None
    try:
        if spec.get('host'):
            try:
                device = await Discover.discover_single(spec['host'], username=username, password=password, discovery_timeout=2, timeout=2)
                if device:
                    await device.update()
            except Exception:
                if device:
                    await device.disconnect()
                device = None
        def matches(d):
            return (not spec.get('mac') or mac(d.mac) == mac(spec['mac'])) and (not spec.get('alias') or d.alias.strip().lower() == spec['alias'].strip().lower()) and (not spec.get('model') or d.model.lower().startswith(spec['model'].lower()))
        if device is None or not matches(device):
            if device:
                await device.disconnect()
                device = None
            devices = await Discover.discover(username=username, password=password, discovery_timeout=2, timeout=2)
            found = []
            try:
                for candidate in devices.values():
                    if spec.get('mac') and mac(candidate.mac) != mac(spec['mac']):
                        continue
                    await candidate.update()
                    if matches(candidate):
                        found.append(candidate)
                if len(found) != 1:
                    return {'error': 'Authenticated Kasa identity not found or ambiguous'}
                device = found[0]
            finally:
                for candidate in devices.values():
                    if candidate is not device:
                        await candidate.disconnect()
        if not matches(device):
            return {'error': 'Authenticated Kasa identity mismatch'}
        light = device.modules[Module.Light]
        if args['op'] == 'set':
            state = args['state']
            if state.get('color_temp', 0):
                await light.set_color_temp(state['color_temp'], brightness=state['brightness'])
            else:
                await light.set_hsv(state.get('hue', 0), state.get('saturation', 100), state.get('brightness', 100))
            if state['on_off']:
                await device.turn_on()
            else:
                await device.turn_off()
            await device.update()
        hsv = light.hsv
        actual = {'on_off': int(device.is_on), 'hue': hsv.hue, 'saturation': hsv.saturation,
                  'brightness': light.brightness, 'color_temp': light.color_temp}
        if args['op'] == 'set':
            wanted = args['state']
            keys = ['on_off', 'brightness', 'color_temp'] + ([] if wanted.get('color_temp') else ['hue', 'saturation'])
            if any(actual[k] != wanted[k] for k in keys):
                return {'error': 'Authenticated Kasa light state did not read back'}
        return {'host': device.host, 'alias': device.alias, 'mac': device.mac, 'model': device.model,
                'protocol': 'authenticated', 'credential_file': args['credentials'], 'light_state': actual}
    except Exception:
        return {'error': 'Authenticated Kasa connection/login failed; check power, network, and the saved TP-Link login'}
    finally:
        if device:
            await device.disconnect()


if __name__ == '__main__':
    logging.disable(logging.CRITICAL)
    try:
        print(json.dumps(asyncio.run(run(json.load(sys.stdin)))))
    except Exception:
        print(json.dumps({'error': 'Authenticated Kasa helper failed; check local setup'}))
