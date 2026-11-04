"""Offline authenticated-adapter tests. The Kasa module is replaced with a fake."""
import asyncio
import importlib.util
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

module_spec = importlib.util.spec_from_file_location('adapter', Path(__file__).with_name('m59-kasa-auth.py'))
adapter = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(adapter)


class Bulb:
    def __init__(self, alias='Example lamp', mac='AA:BB:CC:DD:EE:FF'):
        self.alias, self.mac, self.model, self.host = alias, mac, 'KL125', '192.168.1.8'
        self.is_on, self.brightness, self.color_temp = False, 45, 2700
        self.hsv = types.SimpleNamespace(hue=0, saturation=0, value=45)
        self.modules = {'light': self}
        self.calls, self.closed = [], False

    async def update(self): pass
    async def disconnect(self): self.closed = True
    async def turn_on(self): self.is_on = True
    async def turn_off(self): self.is_on = False
    async def set_color_temp(self, value, brightness=None):
        self.color_temp, self.brightness = value, brightness
        self.calls.append('white')
    async def set_hsv(self, hue, saturation, value):
        self.color_temp, self.brightness = 0, value
        self.hsv = types.SimpleNamespace(hue=hue, saturation=saturation, value=value)
        self.calls.append('colour')


class AdapterTests(unittest.TestCase):
    def invoke(self, op='read', state=None, first=None, found=None):
        bulb = first or Bulb()
        async def single(*a, **k): return bulb
        async def scan(**k): return {'candidate': found} if found else {}
        fake = types.SimpleNamespace(Discover=types.SimpleNamespace(discover_single=single, discover=scan), Module=types.SimpleNamespace(Light='light'))
        args = {'op': op, 'spec': {'alias': 'Example lamp', 'mac': 'aabbccddeeff', 'host': '192.168.1.8', 'model': 'KL125'}, 'state': state}
        with patch.dict(sys.modules, {'kasa': fake}), patch.dict(os.environ, {'KASA_USERNAME': 'fixture', 'KASA_PASSWORD': 'fixture'}):
            result = asyncio.run(adapter.run(args | {'credentials': 'unused'}))
        return result, bulb

    def test_read_verifies_identity_and_closes(self):
        result, bulb = self.invoke()
        self.assertEqual(result['alias'], 'Example lamp')
        self.assertTrue(bulb.closed)
        self.assertEqual(result['light_state']['on_off'], 0)

    def test_colour_and_readback(self):
        result, bulb = self.invoke('set', {'on_off': 1, 'hue': 0, 'saturation': 100, 'brightness': 100, 'color_temp': 0})
        self.assertNotIn('error', result)
        self.assertEqual(bulb.calls, ['colour'])
        self.assertTrue(bulb.is_on)

    def test_white_restore_and_power_off(self):
        result, bulb = self.invoke('set', {'on_off': 0, 'hue': 0, 'saturation': 0, 'brightness': 45, 'color_temp': 2700})
        self.assertNotIn('error', result)
        self.assertEqual(bulb.calls, ['white'])
        self.assertFalse(bulb.is_on)

    def test_wrong_identity_never_mutates(self):
        result, bulb = self.invoke('set', {}, first=Bulb(mac='112233445566'))
        self.assertIn('error', result)
        self.assertEqual(bulb.calls, [])

    def test_dhcp_rediscovers_exact_identity(self):
        replacement = Bulb()
        result, old = self.invoke(first=Bulb(mac='112233445566'), found=replacement)
        self.assertEqual(result['mac'], replacement.mac)
        self.assertTrue(old.closed)
        self.assertTrue(replacement.closed)

    def test_missing_credentials_are_actionable_without_disclosure(self):
        with patch.dict(os.environ, {}, clear=True):
            result = asyncio.run(adapter.run({'credentials': 'missing-file'}))
        self.assertIn('login unavailable', result['error'])


if __name__ == '__main__':
    unittest.main()
