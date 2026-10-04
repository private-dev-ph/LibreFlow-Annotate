"""Verify downloaded wheels against authoritative PyPI release hashes; emit pip hash pins."""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.request


def verify(directory):
    root = Path(directory)
    wheels = sorted(root.glob('*.whl'))
    if not wheels:
        raise ValueError('No worker wheels were downloaded')
    seen = set()
    pins = []
    for wheel in wheels:
        if wheel.is_symlink() or not wheel.is_file():
            raise ValueError('Wheelhouse must contain regular downloaded files')
        name, version, *_ = wheel.name.split('-')
        normalized = name.replace('_', '-').lower()
        if normalized in seen:
            raise ValueError('Wheelhouse contains multiple wheels for the same package')
        seen.add(normalized)
        with urllib.request.urlopen(f'https://pypi.org/pypi/{normalized}/{version}/json', timeout=30) as response:
            release = json.load(response)
        artifact = next((item for item in release['urls'] if item['filename'] == wheel.name), None)
        actual = hashlib.sha256(wheel.read_bytes()).hexdigest()
        if not artifact or actual != artifact['digests']['sha256']:
            raise ValueError(f'Authoritative artifact hash check failed for {normalized}')
        pins.append(f'{normalized}=={version} --hash=sha256:{actual}')
    (root / 'requirements.txt').write_text('\n'.join(pins) + '\n')
    print(f'Verified {len(wheels)} PyPI artifacts and wrote complete hashed worker pins')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory')
    verify(parser.parse_args().directory)
