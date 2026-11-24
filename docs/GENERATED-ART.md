# Generated visual assets

Generated with the built-in ChatGPT image generation tool on 2026-11-23. No API key or fallback CLI was used.

Runtime assets: `public/art/*.webp`. Full-resolution source images: `assets/generated-art/*.png`. Rebuild browser assets with `node tools/prepare-art.mjs` (requires installed Chrome). The converter preserves alpha, caps material tiles at 1024px and the blood decal at 512px. The full thirteen-image runtime set totals approximately 2.56 MB (2.45 MiB).

## Integration

- `arena-night`: main menu, venue detail cards, and event/leaderboard backdrop.
- `gym`: training menu detail cards and first-run guide.
- `audience`: same-network menu detail art.
- `canvas`: boxing ring fighting surface.
- `leather`: menu, training and career panel surfaces.
- `concrete`: arena hall floors in previews and fights.
- `blood`: transparent floor marks after landed/taken punches above 0.65 power. Maximum 16 small marks per scene. These are ambient central-area marks because the existing impact log does not supply contact world coordinates. Marks reset when the scene is rebuilt.

Textures are owned and disposed per scene. The generated artwork does not change hit registration, damage calculations, scoring, camera input, or menu availability.

## Generation prompts

Each entry below was a separate built-in image generation request. Images were generated without reference images.

### arena-night
Use case: stylized-concept. Asset type: boxing videogame menu background. Create a cinematic wide 1536x1024 photograph-like underground boxing arena, empty ring in lower right, dense audience in shadow, overhead industrial truss lights, warm amber beams and cool blue haze, worn concrete warehouse architecture, premium gritty sports videogame art. Left half mostly dark atmospheric negative space for readable live UI. No words, logos, watermarks or UI. Save output as arena-night.

### canvas
Use case: stylized-concept. Asset type: seamless boxing ring canvas base color texture for a 3D game. Square orthographic overhead closeup of worn desaturated slate blue woven cotton duck canvas, subtle crossed fibers, scattered pale chalk and shoe scuff wear, restrained dark discoloration. Uniform diffuse flat illumination, edge to edge material only, seamless tileable edges. No text, logos, seams, objects, perspective, shadows or blood. Texture must read well covering an entire boxing ring.

### audience
Use case: stylized-concept. Asset type: panoramic spectator stand image for background planes in a 3D boxing game. Wide straight-on eye-level view FROM the boxing ring of packed ascending rows of diverse adult spectators cheering, individual faces and clothing recognizable in front rows, dark upper rows. Black warehouse venue, faint blue rim light and warm amber highlights, cinematic realistic game art. No boxing ring, fighters, ropes, foreground objects, words or logos. Image fills edge to edge with crowd seating, straight horizon, flat frontal composition, no fisheye.

### leather
Use case: stylized-concept. Asset type: seamless dark leather material for boxing videogame turnbuckle padding and UI panels. Square flat orthographic macro photograph of charcoal black worn leather, fine natural pebbled grain, subtle abrasions, understated soft tonal variation, neutral diffuse lighting, seamless tileable edges. No seams, folds, lettering, logos, objects, perspective, highlights or border. Full bleed material texture only.

### blood
Transparent background enabled.

Use case: stylized-concept. Asset type: single transparent blood splatter decal for a boxing sports game floor. Isolated small irregular dark crimson blood splash with a few tiny satellite droplets, realistic liquid edges and translucent thin spots, top down orthographic view, centered with generous transparent margins. Restrained sports injury scale, no body parts, wounds, objects, text, shadow or background. Actual transparent alpha background. One cohesive splash only.

### concrete
Use case: stylized-concept. Asset type: seamless industrial arena floor base color texture for 3D boxing videogame. Square straight-down orthographic photograph of charcoal grey aged concrete, subtle aggregate grain, faint scrapes, shoes scuffs, dusty mottling, understated gritty warehouse character. Flat diffuse lighting, seamless tiling edges. No cracks forming strong recognizable patterns, no lines, objects, text, logos, perspective, cast shadows or blood. Full bleed texture.

### gym
Use case: stylized-concept. Asset type: boxing training videogame panel background. Wide cinematic photograph of an old boxing gym, distressed brick walls, hanging heavy bags on right, empty worn wood floor, tall industrial windows with cool morning light and warm dusty shafts, vintage unlettered fight posters, boxing gloves on bench. Quiet determined atmosphere, realistic premium game concept art, dark left half for UI text. No people, readable words, logos, watermarks or interface.

## Second visual pass

Six further images were generated with the same built-in tool, bringing the set to thirteen. Sources remain in `assets/generated-art/` and optimized runtime images in `public/art/`.

- `rubber`: dummy weighted base and training-room floor.
- `steel`: dummy column, ring/cage posts, gym supports, and online/leaderboard panel surfaces.
- `locker-room`: career menu illustration and career panel header.
- `fight-banner`: four arena wall banners and two training-room signs, using the existing ShadowBox name.
- `oxblood`: woven arena platform skirts.
- `brick`: training-room walls.

Dummy/free-work training now includes a static gym room with a rubber floor, brick walls, steel supports, signs, and framed gym artwork. It uses existing scene lights, adds no animation or shadow maps, and does not affect target raycasts or scoring. It is only built for dummy modes without a fight venue. Training-room and arena dressing resources are disposed by their builders.

### rubber
Use case: stylized-concept. Asset type: seamless material texture for a 3D boxing game. Square orthographic macro of dark charcoal recycled rubber gym flooring, tightly packed tiny rubber granules, worn matte surface, subtle scattered grey flecks, even diffuse lighting. Fine scale, restrained contrast, seamless tileable edges. Full bleed material only. No objects, seams, lines, words, logos, shadows or perspective.

### steel
Use case: stylized-concept. Asset type: seamless material texture for boxing videogame equipment. Square orthographic closeup of aged dark gunmetal steel, fine brushing, restrained scuffs, small spots of oxidized patina, subtle grey tonal variation. Uniform diffuse lighting, seamless tiling edges, physically plausible material. No bolts, seams, objects, words, logos, perspective, cast shadows or dramatic highlights. Full bleed material.

### locker-room
Use case: stylized-concept. Asset type: boxing videogame career panel illustration. Wide cinematic photograph-like composition of a quiet old boxing locker room, dark steel lockers, weathered wooden bench, red and blue boxing gloves, white hand wraps and a modest aged gold championship belt resting on bench on the RIGHT side. Moody warm amber practical lights, cool shadows, textured concrete and brick, premium realistic videogame worldbuilding art. Left half mostly dark negative space, no people, no readable words, logos, watermarks or UI.

### fight-banner
Use case: stylized-concept. Asset type: arena wall banner texture for 3D boxing videogame. Very wide horizontal distressed printed black cotton fight-club banner, restrained cream and amber ink. Exact text 'SHADOWBOX' in huge bold condensed athletic uppercase centered, exact smaller text 'FIGHT NIGHT' below. Subtle faded ink and worn fabric grain, thin amber horizontal rules, no other text, no logos, no grommets, no folds, no border outside image. Flat front-on orthographic scan of the fabric banner, edge to edge design, not a photograph of a banner hanging in a scene. 3 to 1 aspect ratio.

### oxblood
Use case: stylized-concept. Asset type: seamless woven cloth material for 3D boxing videogame equipment and ring apron. Square orthographic macro photograph of deep red oxblood woven vinyl-coated fabric, fine crosshatched weave, restrained surface wear and rub marks, subtle neutral tonal variation. Uniform diffuse lighting. Seamless tileable edges. Full bleed material only, no stitching, seams, folds, objects, words, logos, perspective, cast shadows or dramatic highlights.

### brick
Use case: stylized-concept. Asset type: seamless wall texture for a 3D boxing gym videogame. Square straight-on orthographic scan of aged dark reddish brown industrial brickwork with charcoal mortar, fine chipped brick edges, restrained pale dust and subtle wear, old warehouse character. Even diffuse neutral illumination, seamless tiling edges. Small consistent bricks, full bleed wall material only. No graffiti, signs, posters, text, objects, perspective, directional light, heavy stains or cast shadows.


## Venue and entry artwork

Generated with the built-in ChatGPT image generation tool. Source PNGs and optimized WebPs are in the same folders as the previous passes. The fifteen runtime assets total about 3 MB.

- **Cage preview.** The venue picker uses this image to distinguish the cage from the roped ring. Prompt: Wide cinematic sports videogame environment illustration, empty regulation octagonal chain-link fighting cage in a repurposed warehouse, slate canvas, black fence and deep red padded posts, cool blue overhead lighting with warm amber balcony practicals, dim spectators behind the fence. Oblique three-quarter view, cage unmistakably octagonal and centered for small preview thumbnail. Photorealistic gritty materials, no lettering, branding, overlays or fighters.
- **Fighter tunnel.** The camera entry screen uses this backdrop. Prompt: Wide cinematic sports videogame environment illustration, view from within a narrow dark brick and concrete fighter entrance tunnel looking toward an amber-lit boxing ring and shadowy crowd at the far end. Cool blue shadows, industrial doors, dramatic but restrained haze, gritty original boxing club art. Keep central band readable and no people in foreground, text, logos or overlays.
## Crowd depth, character materials and UI artwork

Fourteen more images from the built-in ChatGPT image generation tool bring the collection to 29 source images and 28 runtime assets. Source PNGs are in `assets/generated-art/` and runtime WebPs are in `public/art/`. The converter packs the two transparent ringside sheets into one atlas with eight spectators.

The arena places seated sprite instances inside separate lower, upper and rear spectator tiers. The layers sit at different heights and radii, so camera movement gives them different apparent speeds. Only the ringside instances move during fights. Reduced motion disables that movement, venue auto-orbit, crowd camera flashes and the hit flash.

Skin detail blends into each fighter's base complexion below damage. A bind-space mask keeps buzz-cut hair attached to the existing rig, while leather and fabric bump maps use the gear's existing UVs. The octagon uses a distinct charcoal mat, and the ring uses tinted vinyl for its corner pads.

### Generation prompts

**crowd-lower.** Use case: stylized-concept. Wide 3:1 panoramic game environment texture. Straight-on eye-height view of a dense row of diverse adult boxing spectators, seated, two staggered rows from waist up behind a dark rail, watching an unseen boxing ring, a few clapping, varied natural reactions and clothes. Warm amber highlights, restrained dim warehouse background with charcoal shadows. Faces and bodies distinguishable from medium distance. No ring, text, logos, foreground objects or perspective vanishing point.

**crowd-upper.** Use case: stylized-concept. Wide 3:1 panoramic game environment texture, straight-on view of densely packed distant adult spectators in an upper industrial warehouse boxing balcony behind a black steel railing. Many small varied people in rows, dull blue light and a few restrained warm highlights, very dark background, faint venue structure. Waist up from a distance. No boxing ring, signs, logos, words, wandering foreground figures or angled horizon.

**skin-grain.** Use case: stylized-concept. Square seamless neutral grayscale microtexture for a 3D videogame character skin material. Flat orthographic scan of human skin surface microdetail, fine subtle pores and tiny fine natural creases, low contrast and very even neutral gray across all four edges. This is a tileable neutral detail map to blend with multiple complexion colors. No anatomical feature, hair, marks, moles, scars, directional light, text, objects or shadows.

**hair-grain.** Use case: stylized-concept. Square tileable diffuse game material of extremely short dark brown buzz-cut hair, top-down orthographic macro view with tightly packed short dark hair follicles, very subtle direction, almost black soft neutral brown with fine variation. The full frame is hair material only, no face, skull, skin outline, logos or lighting gradient. Understated natural matte surface.

**glove-grain.** Use case: stylized-concept. Square tileable material scan for a realistic 3D boxing glove, gray midtone pebble-grain leather, very fine subtle rounded creases and small abrasion, neutral grey for tinting red or blue in the shader, perfectly flat diffuse orthographic lighting. No glove shape, stitching, letters, silhouette, seams or shadow.

**shorts-weave.** Use case: stylized-concept. Square tileable material scan for a 3D boxing game. Neutral gray fine-woven boxing trunk satin fabric, nuanced diagonal warp and weft threading, slightly matte and low contrast, perfectly flat evenly lit orthographic full frame texture for tinting. No edges, garment shape, folds, print, lettering, stitching or shadows.

**results-art.** Use case: stylized-concept. Wide 3:1 cinematic boxing game interface background photograph, empty ring after the final bell with worn slate canvas and two distant corner stools, low warm arena spotlights, deep charcoal shadows, soft audience blur at far edge. Keep central area dark and subdued so UI can appear above. No people, type, logos, overlays or artifacts.

**wraps-art.** Use case: stylized-concept. Wide 3:1 cinematic boxing gym still life, clean white fabric hand wraps partly unspooled with a pair of worn oxblood leather gloves and simple round gym timer on a timber bench, aged brick and warm side light, deep charcoal backdrop. Subjects centered right, no words, digits, logos or UI. Premium grounded realistic boxing game art.

**cage-mat.** Use case: stylized-concept. Square orthographic seamless game texture of a charcoal slate-gray coated octagon fight mat, resilient dense matte material, subtly worn by shoes, understated scuffs, small surface variation, no hard highlights. Uniform flat light and tileable edges. No diagram, ring, logos, lettering, blood, objects, perspective or cast shadows.

**corner-vinyl.** Use case: stylized-concept. Square orthographic seamless game texture of muted warm gray slightly textured padded sports vinyl, tiny mottled grains and fine abrasions. Neutral diffuse illumination suitable for multiplying against red or blue. Full bleed material. No folds, seams, lettering, stitches, objects, shadows or perspective.

**crowd-ringside.** Use case: stylized-concept. Transparent horizontal sprite atlas of four isolated waist-up adult boxing spectators, equally spaced in quarter-width cells: a woman in a plum jacket, a man in a denim jacket, a man in a grey hoodie, and a woman in a brown jacket. Common waistline, clear gutters, restrained arena light, no props, backdrop or text.

**crowd-ringside-b.** Use case: stylized-concept. Production sprite atlas with real transparent background. Exactly four waist-up seated adult boxing spectators, evenly spaced in one row, generous transparent gutters, each figure fits in one equal quarter of the image and all four share a waistline. From left to right: older woman with silver hair and a teal scarf applauding with hands low, bald muscular man in a quilted black jacket watching with forearms down, young woman with curly brown hair wearing a grey knit sweater and smiling, older bearded man in a rust baseball cap and a navy sports jacket with arms crossed. All face forward under low amber arena light, realistic game art with warm restrained facial highlights. No text, backdrop, chairs, objects, cast shadows or glow. 3:1 very wide.

**crowd-rear.** Use case: stylized-concept. 3:1 boxing videogame horizontal grandstand backdrop, tiled from ring viewpoint, broad uppermost gallery of an old warehouse arena, very distant dense spectators tiny and in soft shadow, steel balcony rail and brickwork, dark navy with dim warm utility lights. Similar dark brick on both edges. No prominent faces or individual close portraits, no ring, signs, logos, letters or white highlights. Straight-on panoramic eye-level architecture.

**tracking-art.** Use case: stylized-concept. Wide 3:1 composition of a small sport webcam on a sturdy stand in a shadowy boxing training studio, foreground right with the lens facing the viewer, slate-blue gym floor and warm brick accents behind, soft practical light, realistic game menu artwork. No ringside spectators, cables across the floor, letters, marks, logos, diagrams or UI.


## Silhouette crowd and fighter wardrobe

Seven additional images were generated with the built-in ChatGPT image generation tool. Gameplay now uses only the outlines of the spectator sprite atlas, with the first row 7.2 world units beyond the arena radius and a separate illustrated balcony behind them. Short soft camera flashes originate in the stands during fights and venue previews. Reduced motion suppresses them.

The wardrobe uses the same rig and materials as gameplay. Saved skin tone, hairstyle, kit colour and finish apply to the local fighter across modes. The preview and saved selection are stored locally. Other players see the standard opponent outfit in their own game.

### Generation prompts

**kit-room.** Use case: stylized-concept. Cinematic wide 3:1 original boxing videogame wardrobe menu artwork: dark industrial locker cubbies with several distinct pairs of red, blue, and muted gold boxing gloves, hand wraps and neatly folded trunks, warm copper and blue accents, premium realistic game art. Objects towards right, no people, text, marks, logos or UI.

**kit-matte.** Use case: stylized-concept. Square seamless orthographic grayscale material texture of finely pebbled padded matte boxing glove leather, low contrast midgray, tiny wear, even flat light, no text, seams, folds or shadows, full bleed texture for shader bump map.

**kit-ribbed.** Use case: stylized-concept. Square seamless orthographic grayscale material texture of subtle tight ribbed performance fabric for boxing trunks, fine threads, medium neutral gray low contrast, even diffuse light, full bleed, no folds seams text or shadows.

**hair-crop.** Use case: stylized-concept. Square seamless orthographic macro game material of tightly curled dark neutral brown short cropped hair, gentle texture variation, full bleed fine dark curls only, no face skin outlines text or directional light.

**silhouette-gallery.** Use case: stylized-concept. Wide 3:1 original boxing game arena background texture, very distant tiny crowd of adult spectators strictly as silhouettes in dark industrial warehouse high balcony, faces entirely indistinguishable, slight cool blue rim light and occasional old amber wall lamps, mostly deep charcoal, simple rail, straight-on panoramic view no ring, no words or logos.

**menu-corner.** Use case: stylized-concept. Wide 16:9 cinematographic original boxing game menu background, inside a dark fight club with a tight view of the boxing ring's red leather corner pad and cream ropes on the RIGHT, a worn timber floor and overhead amber lamp, deep charcoal and cool navy shadows. The left half stays very dark with sparse detail for text. No people, words, logos or interface. Realistic materials.

**training-banner.** Use case: stylized-concept. Wide panoramic 3:1 original boxing game UI artwork, dark red heavy bag with taped stitching at right side in brick training room, warm sidelight, navy shadows, subtle floating dust. High detail material, dark left area for overlay. No people, words or logos.

