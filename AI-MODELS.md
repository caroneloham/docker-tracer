# Catalogue de modèles IA

Vérifié le 19 septembre 2026 auprès des auteurs et pour le moteur `vllm/vllm-openai:v0.29.0`. Les dix références sont des modèles de conversation publiés par Qwen ou Mistral AI. La compatibilité documentée ne remplace pas un essai sur le GPU du client ; les dix modèles n’ont pas tous été exécutés sur ce PC.

| Modèle et fiche de l’auteur                                                                                 | Vision | Format du checkpoint          | Poids approximatifs, seuls |
| ----------------------------------------------------------------------------------------------------------- | ------ | ----------------------------- | -------------------------- |
| [Qwen3 0.6B](https://huggingface.co/Qwen/Qwen3-0.6B)                                                        | Non    | BF16                          | 1,4 Gio                    |
| [Qwen3 4B](https://huggingface.co/Qwen/Qwen3-4B)                                                            | Non    | BF16                          | 7,5 Gio                    |
| [Qwen3 8B](https://huggingface.co/Qwen/Qwen3-8B)                                                            | Non    | BF16                          | 15,3 Gio                   |
| [Qwen3 VL 2B Instruct](https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct)                                    | Oui    | BF16                          | 4,0 Gio                    |
| [Qwen3 VL 4B Instruct](https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct)                                    | Oui    | BF16                          | 8,3 Gio                    |
| [Ministral 3 3B Instruct 2512](https://huggingface.co/mistralai/Ministral-3-3B-Instruct-2512)               | Oui    | FP8, certains composants BF16 | 4,4 Gio                    |
| [Ministral 3 8B Instruct 2512](https://huggingface.co/mistralai/Ministral-3-8B-Instruct-2512)               | Oui    | FP8, certains composants BF16 | 9,7 Gio                    |
| [Ministral 3 14B Instruct 2512](https://huggingface.co/mistralai/Ministral-3-14B-Instruct-2512)             | Oui    | FP8, certains composants BF16 | 14,6 Gio                   |
| [Mistral 7B Instruct v0.3](https://huggingface.co/mistralai/Mistral-7B-Instruct-v0.3)                       | Non    | BF16                          | 13,5 Gio                   |
| [Mistral Small 3.2 24B Instruct 2506](https://huggingface.co/mistralai/Mistral-Small-3.2-24B-Instruct-2506) | Oui    | BF16                          | 44,7 Gio                   |

## Estimation mémoire

`shared/ai-models.mjs` conserve la taille des fichiers Safetensors d’un seul format de checkpoint : la somme des shards `model-*.safetensors` pour Qwen, le fichier `consolidated.safetensors` pour Mistral. On ne cumule jamais les formats Hugging Face et Mistral qui contiennent les mêmes poids. Les tailles et révisions ont été relevées via les listes de fichiers des dépôts officiels, par exemple [les fichiers Ministral 3 8B](https://huggingface.co/mistralai/Ministral-3-8B-Instruct-2512/tree/main).

Cette valeur inclut les tenseurs stockés, y compris la vision, les embeddings et les composants BF16 des modèles FP8. C’est une estimation des poids, pas une promesse de consommation VRAM exacte. Le cache des conversations, les buffers CUDA, les images et les requêtes simultanées consomment aussi de la mémoire. Un modèle dont les poids tiennent tout juste ne doit pas être présenté comme garanti compatible. Pour un modèle personnalisé non référencé, l’estimation reste celle de poids en 16 bits : `paramètres × 2 octets`.

Les noms commerciaux ne décrivent pas toujours tous les tenseurs du fichier. Ainsi le checkpoint Qwen3 0.6B représente environ 1,4 Gio sur disque. Les Ministral 3 vision ont aussi un encodeur visuel en plus du modèle de langage. La précision FP8 décrit le checkpoint publié ; aucune quantification supplémentaire ni conversion BF16 n’est déclenchée par le catalogue.

## Paramètres du moteur

Les cinq Mistral utilisent explicitement leur format natif : `--tokenizer-mode mistral --config-format mistral --load-format mistral`, avec le parseur d’outils `mistral`. Les cinq Qwen utilisent le parseur `hermes`. Les variantes Qwen3 VL Instruct publiées contiennent bien le format JSON Hermes dans leur propre [template de conversation](https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct/blob/main/chat_template.jinja). Les modèles texte Qwen3 sont également couverts par le [guide officiel Qwen sur les appels d’outils](https://github.com/QwenLM/Qwen3/blob/main/docs/source/framework/function_call.md).

Le [guide vLLM 0.29 sur les outils](https://docs.vllm.ai/en/v0.29.0/features/tool_calling/) décrit le format Mistral et signale notamment les limites de Mistral 7B avec les appels parallèles. Les architectures Qwen3, Qwen3 VL et Mistral/Pixtral sont présentes dans le [registre de vLLM 0.29.0](https://github.com/vllm-project/vllm/blob/v0.29.0/vllm/model_executor/models/registry.py). Les modèles inconnus ne reçoivent aucun argument spécifique automatiquement. Le catalogue n’ajoute pas `--trust-remote-code`.

## Allocation automatique : convention

Dans vLLM, `gpu_memory_utilization` est une fraction de la VRAM **totale**, propre à chaque instance. Ce n’est pas une fraction de la VRAM libre. Une estimation automatique doit tenir compte de la mémoire libre mesurée sur chaque GPU sélectionné et laisser une marge aux autres processus. Avec plusieurs GPU et une fraction commune, le GPU le plus contraint impose la limite. Le réglage ne réserve pas les ressources contre d’autres programmes démarrés ensuite. [Configuration mémoire vLLM 0.29.0](https://github.com/vllm-project/vllm/blob/v0.29.0/vllm/config/cache.py)

Pour Docker Desktop, la RAM et les CPU disponibles au moteur Docker restent la limite utile, même si le PC possède davantage de RAM physique. Les estimations de mémoire du modèle et du serveur doivent rester distinctes.
